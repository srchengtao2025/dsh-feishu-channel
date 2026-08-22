import { randomUUID } from 'node:crypto'
import * as Lark from '@larksuiteoapi/node-sdk'
import { chunkText } from './message.js'

const OPEN_API_DOMAINS = Object.freeze({
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
})

function safeError(error) {
  if (error instanceof Error) return error.message.replace(/cli_[0-9a-fA-F]{16}/g, 'cli_***')
  return String(error)
}

export class TextEditStreamController {
  constructor({ edit, initialText, throttleMs = 800, maxEdits = 20, logger }) {
    this.edit = edit
    this.content = initialText
    this.sent = initialText
    this.throttleMs = throttleMs
    this.maxEdits = maxEdits
    this.logger = logger
    this.editsStarted = 0
    this.timer = undefined
    this.tail = Promise.resolve()
    this.failure = undefined
  }

  append(chunk) {
    return this.setContent(`${this.content}${chunk ?? ''}`)
  }

  setContent(full) {
    this.content = String(full ?? '')
    this.schedule()
    return Promise.resolve()
  }

  schedule() {
    if (this.timer || this.failure || this.editsStarted >= this.maxEdits - 1) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.enqueue(false)
    }, this.throttleMs)
    this.timer.unref?.()
  }

  enqueue(final) {
    const snapshot = this.content || '…'
    if (snapshot === this.sent || this.failure) return this.tail
    const limit = final ? this.maxEdits : this.maxEdits - 1
    if (this.editsStarted >= limit) return this.tail
    this.editsStarted += 1
    this.tail = this.tail.then(async () => {
      try {
        await this.edit(snapshot)
        this.sent = snapshot
      } catch (error) {
        this.failure = error
        this.logger?.warn?.(`飞书文本流式更新失败：${safeError(error)}`)
      }
    })
    return this.tail
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.tail
    if (this.failure) throw this.failure
    await this.enqueue(true)
    if (this.failure) throw this.failure
  }
}

export async function testFeishuCredentials({ appId, appSecret, domain = 'feishu', fetchImpl = fetch }) {
  const baseUrl = OPEN_API_DOMAINS[domain]
  if (!baseUrl) throw new Error('平台域必须是 feishu 或 lark')
  const response = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.code !== 0) {
    throw new Error(`飞书鉴权失败：${body.msg || `HTTP ${response.status}`}`)
  }
  return { ok: true, expire: body.expire }
}

export class FeishuChannel {
  constructor({ onMessage, onCardAction, logger }) {
    this.onMessage = onMessage
    this.onCardAction = onCardAction
    this.logger = logger
    this.client = undefined
    this.outboundChannel = undefined
    this.wsClient = undefined
    this.streamMode = 'unknown'
    this.fileResourceGranted = undefined
    this.generation = 0
    this.status = {
      state: 'disabled',
      detail: '通道尚未启用',
      changedAt: Date.now(),
    }
  }

  snapshot() {
    const sdkStatus = this.wsClient?.getConnectionStatus?.()
    return {
      ...this.status,
      streamMode: this.streamMode,
      fileResourceGranted: this.fileResourceGranted,
      ...(sdkStatus ? { sdkState: sdkStatus.state, reconnectAttempts: sdkStatus.reconnectAttempts } : {}),
    }
  }

  setStatus(state, detail) {
    this.status = { state, detail, changedAt: Date.now() }
  }

  async configure(config, appSecret) {
    const generation = ++this.generation
    this.close()
    if (!config.enabled) {
      this.setStatus('disabled', '通道已停用')
      return
    }
    if (!config.appId || !appSecret) {
      this.setStatus('incomplete', 'App ID 或 App Secret 尚未配置')
      return
    }

    this.setStatus('connecting', '正在连接飞书长连接')
    const sdkDomain = config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
    const sdkLogger = {
      error: (...args) => this.logger.error(args.map(String).join(' ')),
      warn: (...args) => this.logger.warn(args.map(String).join(' ')),
      info: (...args) => this.logger.info(args.map(String).join(' ')),
      debug: (...args) => this.logger.debug(args.map(String).join(' ')),
      trace: (...args) => this.logger.debug(args.map(String).join(' ')),
    }

    const client = new Lark.Client({
      appId: config.appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: sdkDomain,
      logger: sdkLogger,
      loggerLevel: Lark.LoggerLevel.warn,
      source: 'dsh-feishu-channel',
    })
    const outboundChannel = new Lark.LarkChannel({
      appId: config.appId,
      appSecret,
      domain: sdkDomain,
      logger: sdkLogger,
      loggerLevel: Lark.LoggerLevel.warn,
      source: 'dsh-feishu-channel',
      outbound: {
        streamThrottleMs: 500,
        streamThrottleChars: 20,
        streamInitialText: config.acknowledgement || '正在生成…',
        streamMaxElementChars: 30_000,
        allowedFileDirs: [config.defaultWorkspace],
      },
    })
    const dispatcher = new Lark.EventDispatcher({ logger: sdkLogger, loggerLevel: Lark.LoggerLevel.warn })
      .register({
        'im.message.receive_v1': data => {
          queueMicrotask(() => {
            Promise.resolve(this.onMessage(data)).catch(error => {
              this.logger.error(`处理飞书消息失败：${safeError(error)}`)
            })
          })
        },
        'card.action.trigger': data => this.onCardAction(data),
      })
    const wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret,
      domain: sdkDomain,
      logger: sdkLogger,
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: true,
      handshakeTimeoutMs: 12_000,
      wsConfig: { pingTimeout: 10 },
      source: 'dsh-feishu-channel',
      onReady: () => {
        if (generation === this.generation) this.setStatus('connected', '飞书长连接已建立')
      },
      onReconnecting: () => {
        if (generation === this.generation) this.setStatus('reconnecting', '飞书长连接正在重连')
      },
      onReconnected: () => {
        if (generation === this.generation) this.setStatus('connected', '飞书长连接已恢复')
      },
      onError: error => {
        if (generation === this.generation) this.setStatus('error', safeError(error))
      },
    })
    this.client = client
    this.outboundChannel = outboundChannel
    this.wsClient = wsClient
    await wsClient.start({ eventDispatcher: dispatcher })
    try {
      const response = await client.application.v6.scope.list({})
      if (response?.code && response.code !== 0) throw new Error(response.msg || String(response.code))
      const scopes = response?.data?.scopes ?? []
      this.fileResourceGranted = scopes.some(scope => scope.scope_name === 'im:resource' && scope.grant_status === 1)
    } catch (error) {
      this.fileResourceGranted = undefined
      this.logger.warn(`无法查询飞书文件资源授权状态：${safeError(error)}`)
    }
  }

  close() {
    this.wsClient?.close({ force: true })
    this.wsClient = undefined
    this.client = undefined
    this.outboundChannel = undefined
    this.streamMode = 'unknown'
    this.fileResourceGranted = undefined
  }

  async sendTextReply(messageId, text) {
    if (!this.client) throw new Error('飞书通道尚未连接')
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
        uuid: randomUUID(),
      },
    })
    if (response?.code && response.code !== 0) throw new Error(`飞书回复失败：${response.msg || response.code}`)
    const replyMessageId = response?.data?.message_id
    if (!replyMessageId) throw new Error('飞书回复成功但没有返回 message_id')
    return replyMessageId
  }

  async replyText(messageId, text) {
    if (!this.client) throw new Error('飞书通道尚未连接')
    for (const [index, chunk] of chunkText(text).entries()) {
      await this.sendTextReply(messageId, chunk)
    }
  }

  async openMessageResource(message) {
    if (!this.client) throw new Error('飞书通道尚未连接')
    if (!message.resource?.fileKey) throw new Error('文件消息缺少资源 key')
    const response = await this.client.im.v1.messageResource.get({
      params: { type: message.resource.type },
      path: { message_id: message.messageId, file_key: message.resource.fileKey },
    })
    return response.getReadableStream()
  }

  async sendFileReply(message, file) {
    if (!this.outboundChannel) throw new Error('飞书通道尚未连接')
    return this.outboundChannel.send(message.chatId, {
      file: { source: file.path, fileName: file.name },
    }, { replyTo: message.messageId })
  }

  async streamReply(message, initialText, producer) {
    if (!this.client || !this.outboundChannel) throw new Error('飞书通道尚未连接')
    let producerStarted = false
    try {
      const result = await this.outboundChannel.stream(message.chatId, {
        markdown: async controller => {
          producerStarted = true
          await producer(controller)
        },
      }, { replyTo: message.messageId })
      this.streamMode = 'cardkit'
      return result
    } catch (error) {
      if (producerStarted) throw error
      this.streamMode = 'text-edit'
      this.logger.warn(`CardKit 流式不可用，降级为文本编辑流式：${safeError(error)}`)
    }

    const placeholder = initialText || '正在生成…'
    const replyMessageId = await this.sendTextReply(message.messageId, placeholder)
    const controller = new TextEditStreamController({
      initialText: placeholder,
      throttleMs: 800,
      maxEdits: 20,
      logger: this.logger,
      edit: async text => {
        const response = await this.client.im.v1.message.update({
          path: { message_id: replyMessageId },
          data: { msg_type: 'text', content: JSON.stringify({ text }) },
        })
        if (response?.code && response.code !== 0) throw new Error(`飞书编辑消息失败：${response.msg || response.code}`)
      },
    })
    try {
      await producer(controller)
      await controller.flush()
    } catch (error) {
      await controller.setContent(`${controller.content}\n\n⚠️ 生成中断`)
      await controller.flush().catch(() => undefined)
      throw error
    }
    return { messageId: replyMessageId }
  }

  async replyApprovalCard(messageId, approval) {
    if (!this.client) throw new Error('飞书通道尚未连接')
    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: 'DeepSeek Harness 操作确认' },
      },
      elements: [
        { tag: 'markdown', content: `**工具**：${approval.toolName}\n**原因**：${approval.reason || '该操作超出当前沙箱权限，需要一次性授权。'}\n\n授权仅对本次操作有效。` },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button', type: 'primary',
              text: { tag: 'plain_text', content: '允许一次' },
              value: { dshAction: 'approval', token: approval.token, decision: 'allow' },
              confirm: { title: { tag: 'plain_text', content: '确认允许？' }, text: { tag: 'plain_text', content: '该授权仅用于当前这一次工具调用。' } },
            },
            {
              tag: 'button', type: 'danger',
              text: { tag: 'plain_text', content: '拒绝' },
              value: { dshAction: 'approval', token: approval.token, decision: 'reject' },
            },
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `备用命令：/approve ${approval.token} 或 /reject ${approval.token}` }] },
      ],
    }
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        uuid: `approval-${approval.token}`,
      },
    })
    if (response?.code && response.code !== 0) throw new Error(`发送审批卡片失败：${response.msg || response.code}`)
  }
}
