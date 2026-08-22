import { isAbsolute, normalize } from 'node:path'

export const FEISHU_SECRET_REF = 'FEISHU_APP_SECRET'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  domain: 'feishu',
  appId: '',
  allowedOpenIds: [],
  defaultWorkspace: '/var/lib/dsh/workspace',
  allowGroupAt: false,
  acknowledgement: '收到，正在处理…',
  streamingEnabled: true,
  fileTransferEnabled: true,
  maxFileSizeMb: 30,
  knowledgeBaseEnabled: false,
  knowledgeBaseUrl: '',
  knowledgeBaseSyncMinutes: 15,
  knowledgeBaseMaxResults: 5,
})

const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/
const OPEN_ID_PATTERN = /^ou_[a-zA-Z0-9]+$/

export function normalizeOpenIds(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；]+/)
  return [...new Set(entries.map(item => String(item).trim()).filter(Boolean))]
}

export function normalizeConfig(input = {}) {
  const config = {
    enabled: input.enabled === true,
    domain: String(input.domain ?? DEFAULT_CONFIG.domain).trim().toLowerCase(),
    appId: String(input.appId ?? '').trim(),
    allowedOpenIds: normalizeOpenIds(input.allowedOpenIds),
    defaultWorkspace: normalize(String(input.defaultWorkspace ?? DEFAULT_CONFIG.defaultWorkspace).trim()),
    allowGroupAt: input.allowGroupAt === true,
    acknowledgement: String(input.acknowledgement ?? DEFAULT_CONFIG.acknowledgement).trim(),
    streamingEnabled: input.streamingEnabled !== false,
    fileTransferEnabled: input.fileTransferEnabled !== false,
    maxFileSizeMb: Number(input.maxFileSizeMb ?? DEFAULT_CONFIG.maxFileSizeMb),
    knowledgeBaseEnabled: input.knowledgeBaseEnabled === true,
    knowledgeBaseUrl: String(input.knowledgeBaseUrl ?? '').trim(),
    knowledgeBaseSyncMinutes: Number(input.knowledgeBaseSyncMinutes ?? DEFAULT_CONFIG.knowledgeBaseSyncMinutes),
    knowledgeBaseMaxResults: Number(input.knowledgeBaseMaxResults ?? DEFAULT_CONFIG.knowledgeBaseMaxResults),
  }

  const errors = []
  if (!['feishu', 'lark'].includes(config.domain)) errors.push('平台域必须是 feishu 或 lark')
  if (config.appId && !APP_ID_PATTERN.test(config.appId)) errors.push('App ID 应为 cli_ 加 16 位十六进制字符')
  if (!isAbsolute(config.defaultWorkspace)) errors.push('默认工作目录必须是绝对路径')
  if (config.allowedOpenIds.some(id => !OPEN_ID_PATTERN.test(id))) {
    errors.push('允许用户列表中存在无效 open_id（应以 ou_ 开头）')
  }
  if (config.acknowledgement.length > 120) errors.push('处理中提示不能超过 120 个字符')
  if (!Number.isInteger(config.maxFileSizeMb) || config.maxFileSizeMb < 1 || config.maxFileSizeMb > 30) {
    errors.push('文件大小上限必须是 1 到 30 MB 的整数')
  }
  if (!Number.isInteger(config.knowledgeBaseSyncMinutes) || config.knowledgeBaseSyncMinutes < 5 || config.knowledgeBaseSyncMinutes > 1440) {
    errors.push('知识库同步间隔必须是 5 到 1440 分钟的整数')
  }
  if (!Number.isInteger(config.knowledgeBaseMaxResults) || config.knowledgeBaseMaxResults < 1 || config.knowledgeBaseMaxResults > 10) {
    errors.push('知识库检索结果数必须是 1 到 10 的整数')
  }
  if (config.knowledgeBaseEnabled) {
    try {
      const url = new URL(config.knowledgeBaseUrl)
      const expectedSuffix = config.domain === 'lark' ? '.larksuite.com' : '.feishu.cn'
      if (!url.hostname.endsWith(expectedSuffix) || !/^\/wiki\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error()
    } catch {
      errors.push(`知识库链接必须是当前${config.domain === 'lark' ? ' Lark' : '飞书'}域下的 /wiki/<token> 地址`)
    }
  }
  if (config.enabled && !config.appId) errors.push('启用通道前必须填写 App ID')

  return { config, errors }
}

export function resolveConfigSave(config, confirmEnable = false) {
  if (config.enabled && confirmEnable !== true) {
    return { config: { ...config, enabled: false }, needsEnableConfirmation: true }
  }
  return { config, needsEnableConfirmation: false }
}

export function isSenderAllowed(config, message) {
  if (message.chatType === 'p2p' && config.allowedOpenIds.length === 0) return true
  return config.allowedOpenIds.includes(message.openId)
}

export function isSupportedConversation(config, message) {
  if (message.chatType === 'p2p') return true
  return config.allowGroupAt && message.chatType === 'group' && message.mentionsBot === true
}
