import { randomBytes } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { errorFromTurnEnd, hasUnparsedToolProtocol, textDeltaFromAssistantChunk, textFromAssistantMessage } from './message.js'
import { installAgentModelSelection } from './model-selection.js'
import { resolveDefaultAgentPreset } from './preset-composition.js'
import { stableFeishuSessionId } from './session-id.js'

const HELP = [
  '可用命令：',
  '/help 查看帮助',
  '/status 查看当前会话状态',
  '/new 新建会话',
  '/stop 停止正在执行的任务',
  '/approve <代码> 允许一次待审批操作',
  '/reject <代码> 拒绝待审批操作',
].join('\n')

export class AgentBridge {
  constructor(ctx, { sendApproval, sendFile, knowledgeBase, logger }) {
    this.ctx = ctx
    this.sendApproval = sendApproval
    this.sendFile = sendFile
    this.knowledgeBase = knowledgeBase
    this.logger = logger
    this.sessions = new Map()
    this.sessionIds = new Map()
    this.queues = new Map()
    this.pendingApprovals = new Map()
  }

  async handle(message, workspace, stream) {
    const command = message.text.trim()
    if (command === '/help') return HELP
    if (command === '/status') return this.status(message.chatId)
    if (command === '/stop') return this.stop(message.chatId)
    if (command === '/new') return this.newSession(message.chatId)
    const approval = command.match(/^\/(approve|reject)\s+([a-f0-9]{8})$/i)
    if (approval) return this.decideApproval(approval[2].toLowerCase(), message.openId, approval[1] === 'approve')
    if (!command) return '请输入任务内容，或发送 /help 查看命令。'
    return this.enqueue(message.chatId, () => this.run(message, workspace, stream))
  }

  status(chatId) {
    const state = this.sessions.get(chatId)
    if (!state) return '当前还没有 DSH 会话。发送一条任务消息即可创建。'
    return `会话：${state.handle.agent.id}\n状态：${state.handle.agent.status === 'running' ? '执行中' : '空闲'}\n工作目录：${state.workspace}`
  }

  stop(chatId) {
    const state = this.sessions.get(chatId)
    if (!state || state.handle.agent.status !== 'running') return '当前没有正在执行的任务。'
    state.handle.agent.cancel({ kind: 'user' })
    return '已请求停止当前任务。'
  }

  async newSession(chatId) {
    const old = this.sessions.get(chatId)
    if (old) {
      old.handle.agent.cancel({ kind: 'user' })
      await old.handle.dispose()
      this.sessions.delete(chatId)
    }
    this.sessionIds.set(chatId, SessionId(`feishu-${randomBytes(12).toString('hex')}`))
    return '已清空当前飞书会话。下一条消息会创建新的 DSH 会话。'
  }

  enqueue(chatId, task) {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.queues.set(chatId, current)
    current.finally(() => {
      if (this.queues.get(chatId) === current) this.queues.delete(chatId)
    }).catch(() => undefined)
    return current
  }

  async run(message, workspace, stream) {
    const state = await this.ensureSession(message.chatId, workspace)
    state.outputs = []
    state.error = undefined
    state.activeMessage = message
    state.activeStream = stream
    try {
      state.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      }))
      await state.handle.agent.whenIdle()
    } finally {
      await state.activeStream?.flush()
      state.activeMessage = undefined
      state.activeStream = undefined
    }
    if (state.error) throw new Error(`DSH 会话执行失败：${state.error.message || state.error.code || '未知错误'}`)
    const text = state.outputs.join('\n\n').trim()
    if (hasUnparsedToolProtocol(text)) {
      throw new Error('模型返回了未解析的工具调用协议；已阻止内部协议文本发送到飞书。')
    }
    return text || '任务已结束，但没有产生文本回复。'
  }

  async ensureSession(chatId, workspace) {
    const existing = this.sessions.get(chatId)
    if (existing) return existing
    const state = { handle: undefined, workspace, outputs: [], error: undefined, activeMessage: undefined, activeStream: undefined }
    const preset = await resolveDefaultAgentPreset(this.ctx.agentPresets)
    const sessionId = this.sessionIds.get(chatId) ?? SessionId(stableFeishuSessionId(chatId, preset.id))
    this.sessionIds.set(chatId, sessionId)
    const setup = async agentCtx => {
      const currentSelection = () => this.ctx.agentDefaultModel.currentSelection()
      const selected = {
        get current() { return currentSelection() },
        assembled: undefined,
      }
      installAgentModelSelection(agentCtx, selected)
      agentCtx.tools.register(defineTool({
        name: 'feishu_send_file',
        description: 'Send a completed file from the current DSH workspace to the user in the active Feishu conversation. Use this only when the user explicitly asks to receive, download, or be sent a generated file.',
        parameters: {
          path: { type: 'string', required: true, description: 'Absolute path or workspace-relative path of the file to send.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `Sent ${value.name} to the active Feishu conversation (${value.bytes} bytes).` }],
        },
        execute: async args => {
          if (!state.activeMessage) throw new Error('没有可接收文件的活动飞书消息')
          const file = await this.sendFile(state.activeMessage, state.workspace, args.path)
          return { name: file.name, bytes: file.bytes }
        },
        presentCall: args => ({ card: 'generic', title: `Send file to Feishu: ${args.path}`, kind: 'execute', rawInput: args.path }),
      }))
      agentCtx.tools.register(defineTool({
        name: 'feishu_kb_search',
        description: 'Search the configured Feishu/Lark knowledge base before answering questions that may depend on internal company knowledge. Return concise indexed excerpts with source titles and URLs; cite those sources in the answer.',
        parameters: {
          query: { type: 'string', required: true, description: 'A focused natural-language search query.' },
          topK: { type: 'integer', description: 'Number of results from 1 to 10.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true },
              results: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    nodeToken: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    excerpt: { type: 'string', required: true },
                    score: { type: 'number', required: true },
                  },
                },
              },
              indexState: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `Knowledge search returned ${value.results?.length ?? 0} result(s).` }],
        },
        execute: args => this.knowledgeBase.search(args.query, args.topK),
        presentCall: args => ({ card: 'generic', title: `Search Lark knowledge base: ${args.query}`, kind: 'execute', rawInput: args.query }),
      }))
      agentCtx.tools.register(defineTool({
        name: 'feishu_kb_read',
        description: 'Read one document returned by feishu_kb_search from the configured Feishu/Lark knowledge base. The nodeToken must come from a search result.',
        parameters: {
          nodeToken: { type: 'string', required: true, description: 'Knowledge-base node token returned by feishu_kb_search.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              nodeToken: { type: 'string', required: true },
              title: { type: 'string', required: true },
              url: { type: 'string', required: true },
              content: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `Read knowledge document: ${value.title}` }],
        },
        execute: args => this.knowledgeBase.read(args.nodeToken),
        presentCall: args => ({ card: 'generic', title: 'Read Lark knowledge document', kind: 'execute', rawInput: args.nodeToken }),
      }))
      agentCtx.on('session/event', (_session, event) => {
        const delta = textDeltaFromAssistantChunk(event)
        if (delta) state.activeStream?.push(delta)
        if (event.type === 'assistant/message') {
          const text = textFromAssistantMessage(event.data.message)
          if (text) state.outputs.push(text)
        } else {
          state.error = errorFromTurnEnd(event) ?? state.error
        }
      })
      agentCtx.on('approval/request', (request, next) => {
        if (!state.activeMessage) return next()
        return this.requestApproval(state, request)
      }, true)
      await preset.mount(agentCtx)
    }
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    try {
      state.handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    } catch (resumeError) {
      try {
        state.handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd: workspace, agentPreset: preset.id },
          agentOptions,
          setup,
        })
      } catch (createError) {
        throw new AggregateError([resumeError, createError], '无法创建或恢复飞书 DSH 会话')
      }
    }
    this.sessions.set(chatId, state)
    return state
  }

  requestApproval(state, request) {
    const token = randomBytes(4).toString('hex')
    const message = state.activeMessage
    return new Promise(resolve => {
      const finish = outcome => {
        const pending = this.pendingApprovals.get(token)
        if (!pending) return
        this.pendingApprovals.delete(token)
        if (pending.timer) clearTimeout(pending.timer)
        request.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = () => finish('cancelled')
      const timer = setTimeout(() => finish('rejected'), 10 * 60_000)
      timer.unref()
      this.pendingApprovals.set(token, {
        token,
        openId: message.openId,
        toolName: request.toolName,
        reason: request.reason,
        finish,
        timer,
      })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(this.sendApproval(message.messageId, {
        token,
        toolName: request.toolName,
        reason: request.reason,
      })).catch(error => {
        this.logger.error(`发送审批卡片失败：${error instanceof Error ? error.message : String(error)}`)
        finish('unavailable')
      })
    })
  }

  decideApproval(token, openId, allowed) {
    const pending = this.pendingApprovals.get(token)
    if (!pending) return '审批请求不存在或已经失效。'
    if (pending.openId !== openId) return '只有发起任务的用户可以处理这项审批。'
    pending.finish(allowed ? 'allowed-once' : 'rejected')
    return allowed ? '已允许本次操作。' : '已拒绝本次操作。'
  }

  handleCardAction(data) {
    const event = data?.event ?? data
    const value = event?.action?.value
    if (!value || value.dshAction !== 'approval') return undefined
    const openId = String(event?.operator?.open_id ?? '')
    const text = this.decideApproval(String(value.token ?? ''), openId, value.decision === 'allow')
    return { toast: { type: text.startsWith('已') ? 'success' : 'warning', content: text } }
  }

  async dispose() {
    for (const pending of this.pendingApprovals.values()) pending.finish('cancelled')
    await Promise.allSettled([...this.sessions.values()].map(state => state.handle.dispose()))
    this.pendingApprovals.clear()
    this.sessions.clear()
    this.sessionIds.clear()
  }
}
