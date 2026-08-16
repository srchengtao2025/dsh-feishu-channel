import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { AgentBridge } from './agent-bridge.js'
import { DEFAULT_CONFIG, FEISHU_SECRET_REF, isSenderAllowed, isSupportedConversation, normalizeConfig, resolveConfigSave } from './config.js'
import { renderConfigPage } from './config-page.js'
import { FeishuChannel, testFeishuCredentials } from './feishu.js'
import { isSameOrigin, readJson, sendHtml, sendJson, validCsrf } from './http.js'
import { ExpiringDedupe } from './dedupe.js'
import { FileTransferManager, formatBytes, parseFileCommand } from './file-transfer.js'
import { parseFeishuMessageEvent } from './message.js'
import { SafeStreamRelay } from './stream-relay.js'
import { parseWebUiCommand, WebUiTunnelManager } from './webui-tunnel.js'

export const name = 'feishu-channel'
export const inject = ['settings', 'credentials', 'webServer', 'agents', 'agentDefaultModel', 'agentPresets', 'tools']
export const Config = z.object({})

const SettingsSchema = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  appId: z.string().default(DEFAULT_CONFIG.appId),
  allowedOpenIds: z.array(z.string()).default(DEFAULT_CONFIG.allowedOpenIds),
  defaultWorkspace: z.string().default(DEFAULT_CONFIG.defaultWorkspace),
  allowGroupAt: z.boolean().default(DEFAULT_CONFIG.allowGroupAt),
  acknowledgement: z.string().default(DEFAULT_CONFIG.acknowledgement),
  fileTransferEnabled: z.boolean().default(DEFAULT_CONFIG.fileTransferEnabled),
  maxFileSizeMb: z.number().default(DEFAULT_CONFIG.maxFileSizeMb),
})

export async function apply(ctx) {
  const logger = ctx.logger('feishu-channel')
  const settings = ctx.settings.register(settingsNamespace('feishu-channel'), SettingsSchema, { base: DEFAULT_CONFIG })
  const csrfToken = randomBytes(24).toString('hex')
  const dedupe = new ExpiringDedupe()
  let applying = Promise.resolve()

  const channel = new FeishuChannel({
    logger,
    onMessage: handleIncoming,
    onCardAction: data => bridge.handleCardAction(data),
  })
  const files = new FileTransferManager({
    logger,
    openResource: message => channel.openMessageResource(message),
    sendFile: (message, file) => channel.sendFileReply(message, file),
  })
  const bridge = new AgentBridge(ctx, {
    logger,
    sendApproval: (messageId, approval) => channel.replyApprovalCard(messageId, approval),
    sendFile: async (message, workspace, path) => {
      const config = normalizeConfig(settings.get()).config
      if (!config.fileTransferEnabled) throw new Error('文件传输功能当前已禁用')
      return files.send(message, workspace, path, config.maxFileSizeMb)
    },
  })
  const webUi = new WebUiTunnelManager({ logger })

  async function secretValue() {
    return (await ctx.credentials.resolve(credentialRef(FEISHU_SECRET_REF)))?.value
  }

  function reconfigure() {
    applying = applying.catch(() => undefined).then(async () => {
      const config = normalizeConfig(settings.get()).config
      await channel.configure(config, await secretValue())
    }).catch(error => {
      logger.error(`应用飞书配置失败：${error instanceof Error ? error.message : String(error)}`)
      channel.setStatus('error', error instanceof Error ? error.message : String(error))
    })
    return applying
  }

  async function handleIncoming(payload) {
    const parsed = parseFeishuMessageEvent(payload)
    if (!parsed.ok) return
    const message = parsed.value
    if (!message.messageId || dedupe.seen(message.messageId)) return
    const config = normalizeConfig(settings.get()).config
    if (message.text === '/whoami' && message.chatType === 'p2p') {
      await channel.replyText(message.messageId, `你的 open_id：${message.openId}`)
      return
    }
    if (!isSupportedConversation(config, message)) return
    if (!isSenderAllowed(config, message)) {
      await channel.replyText(message.messageId, '当前账号没有远程控制权限。可发送 /whoami 获取 open_id 后由管理员加入允许列表。')
      return
    }
    if (message.resource) {
      try {
        const file = await files.receive(message, config)
        await channel.replyText(message.messageId, `文件已安全接收：${file.name}（${formatBytes(file.bytes)}）\n请发送下一条文字消息，说明需要如何处理；该消息会自动关联刚上传的文件。`)
      } catch (error) {
        logger.error(`接收飞书文件失败：${error instanceof Error ? error.message : String(error)}`)
        await channel.replyText(message.messageId, `文件接收失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    const fileCommand = parseFileCommand(message.text)
    if (fileCommand) {
      try {
        if (!config.fileTransferEnabled) {
          await channel.replyText(message.messageId, '文件传输功能当前已禁用。')
        } else if (fileCommand.kind === 'help') {
          await channel.replyText(message.messageId, '文件命令：\n/file list 查看等待处理的上传文件\n/file send <工作区内路径> 把文件发送到当前飞书会话')
        } else if (fileCommand.kind === 'list') {
          const pending = files.pendingFiles(message.chatId)
          await channel.replyText(message.messageId, pending.length
            ? `等待下一条任务关联的文件：\n${pending.map(file => `- ${file.name}（${formatBytes(file.bytes)}）`).join('\n')}`
            : '当前没有等待处理的上传文件。')
        } else if (fileCommand.kind === 'send') {
          const file = await files.send(message, config.defaultWorkspace, fileCommand.path, config.maxFileSizeMb)
          await channel.replyText(message.messageId, `文件已发送：${file.name}`)
        } else {
          await channel.replyText(message.messageId, '文件命令格式不正确。发送 /file help 查看用法。')
        }
      } catch (error) {
        logger.error(`发送飞书文件失败：${error instanceof Error ? error.message : String(error)}`)
        await channel.replyText(message.messageId, `文件操作失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    const webUiCommand = parseWebUiCommand(message.text)
    if (webUiCommand) {
      if (config.allowedOpenIds.length === 0 || !config.allowedOpenIds.includes(message.openId)) {
        await channel.replyText(message.messageId, '生成临时 Web UI 地址属于高权限操作，请先把你的 open_id 加入允许用户列表。')
        return
      }
      try {
        if (webUiCommand.kind === 'invalid') {
          await channel.replyText(message.messageId, webUiCommand.message)
        } else if (webUiCommand.kind === 'stop') {
          const stopped = await webUi.stop()
          await channel.replyText(message.messageId, stopped.detail)
        } else if (webUiCommand.kind === 'status') {
          const status = webUi.snapshot()
          await channel.replyText(message.messageId, status.url
            ? `${status.detail}\n${status.url}\n到期时间：${new Date(status.expiresAt).toLocaleString('zh-CN')}`
            : status.detail)
        } else {
          const started = await webUi.start(webUiCommand.minutes)
          await channel.replyText(message.messageId, `临时 Web UI 地址已生成，有效期 ${webUiCommand.minutes} 分钟：\n${started.url}\n\n到期后地址自动失效。请不要转发给其他人。`)
        }
      } catch (error) {
        logger.error(`生成临时 Web UI 失败：${error instanceof Error ? error.stack : String(error)}`)
        await channel.replyText(message.messageId, `生成临时 Web UI 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (!message.text.startsWith('/')) {
      try {
        const taskMessage = files.attachPending(message)
        await channel.streamReply(taskMessage, config.acknowledgement, async controller => {
          const stream = new SafeStreamRelay(controller)
          const response = await bridge.handle(taskMessage, config.defaultWorkspace, stream)
          await stream.complete(response)
        })
      } catch (error) {
        logger.error(`DSH 流式任务失败：${error instanceof Error ? error.stack : String(error)}`)
        await channel.replyText(message.messageId, `任务执行失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    try {
      const response = await bridge.handle(message, config.defaultWorkspace)
      await channel.replyText(message.messageId, response)
    } catch (error) {
      logger.error(`DSH 任务失败：${error instanceof Error ? error.stack : String(error)}`)
      await channel.replyText(message.messageId, `任务执行失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function configPayload() {
    const secretInfo = await ctx.credentials.describe(credentialRef(FEISHU_SECRET_REF))
    return {
      ok: true,
      config: normalizeConfig(settings.get()).config,
      secretConfigured: secretInfo.configured,
      secretWritable: secretInfo.writable,
      status: channel.snapshot(),
    }
  }

  function guard(req, res, { csrf = false } = {}) {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: '仅允许通过服务器本地或 SSH 隧道访问配置接口' })
      return false
    }
    if (csrf && !validCsrf(req, csrfToken)) {
      sendJson(res, 403, { ok: false, error: 'CSRF 校验失败，请刷新配置页后重试' })
      return false
    }
    return true
  }

  const routes = [
    ctx.webServer.register({ kind: 'exact', path: '/feishu-channel', handler: (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      sendHtml(res, renderConfigPage(csrfToken))
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/feishu-channel/api/config', handler: (req, res) => {
      Promise.resolve().then(async () => {
        if (!guard(req, res, { csrf: req.method === 'PUT' })) return
        if (req.method === 'GET') return sendJson(res, 200, await configPayload())
        if (req.method !== 'PUT') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
        const body = await readJson(req)
        const normalized = normalizeConfig(body)
        const { config, needsEnableConfirmation } = resolveConfigSave(normalized.config, body.confirmEnable)
        const { errors } = normalized
        if (errors.length) return sendJson(res, 400, { ok: false, error: errors.join('；') })
        if (body.clearAppSecret === true) await ctx.credentials.unset(credentialRef(FEISHU_SECRET_REF))
        else if (typeof body.appSecret === 'string' && body.appSecret.trim()) {
          await ctx.credentials.set(credentialRef(FEISHU_SECRET_REF), body.appSecret.trim())
        }
        if (config.enabled && !(await secretValue())) {
          return sendJson(res, 400, { ok: false, error: '启用通道前必须配置 App Secret' })
        }
        if (config.enabled && body.confirmEnable === true) {
          await testFeishuCredentials({ appId: config.appId, appSecret: await secretValue() })
        }
        await settings.replace(config)
        await reconfigure()
        const result = await configPayload()
        if (needsEnableConfirmation) result.needsEnableConfirmation = true
        sendJson(res, 200, result)
      }).catch(error => sendJson(res, error?.statusCode || 500, { ok: false, error: error instanceof Error ? error.message : String(error) }))
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/feishu-channel/api/test', handler: (req, res) => {
      Promise.resolve().then(async () => {
        if (!guard(req, res, { csrf: true })) return
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
        const body = await readJson(req)
        const appId = String(body.appId ?? settings.get().appId).trim()
        const appSecret = String(body.appSecret ?? '').trim() || await secretValue()
        if (!appId || !appSecret) return sendJson(res, 400, { ok: false, error: '请先填写 App ID 和 App Secret' })
        await testFeishuCredentials({ appId, appSecret })
        sendJson(res, 200, { ok: true, message: '凭据有效，可以获取 tenant_access_token。' })
      }).catch(error => sendJson(res, error?.statusCode || 500, { ok: false, error: error instanceof Error ? error.message : String(error) }))
    } }),
  ]

  const unwatch = settings.watch(() => { void reconfigure() })
  await reconfigure()
  ctx.effect(() => () => {
    unwatch()
    for (const dispose of routes) dispose()
    channel.close()
    return Promise.allSettled([bridge.dispose(), webUi.stop()])
  }, 'feishu-channel.lifecycle')
}
