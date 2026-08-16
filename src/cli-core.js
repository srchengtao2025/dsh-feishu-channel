import { parseArgs } from 'node:util'

export const DEFAULT_URL = 'http://127.0.0.1:3080'

export function parseCliArgs(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: 'string', default: DEFAULT_URL },
      'app-id': { type: 'string' },
      'app-secret-stdin': { type: 'boolean', default: false },
      'clear-app-secret': { type: 'boolean', default: false },
      'allow-open-id': { type: 'string', multiple: true },
      workspace: { type: 'string' },
      ack: { type: 'string' },
      enable: { type: 'boolean', default: false },
      disable: { type: 'boolean', default: false },
      'group-at': { type: 'boolean', default: false },
      'no-group-at': { type: 'boolean', default: false },
      files: { type: 'boolean', default: false },
      'no-files': { type: 'boolean', default: false },
      'max-file-mb': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const command = parsed.positionals[0] ?? 'configure'
  if (parsed.values.enable && parsed.values.disable) throw new Error('--enable 与 --disable 不能同时使用')
  if (parsed.values['group-at'] && parsed.values['no-group-at']) throw new Error('--group-at 与 --no-group-at 不能同时使用')
  if (parsed.values.files && parsed.values['no-files']) throw new Error('--files 与 --no-files 不能同时使用')
  return { command, positionals: parsed.positionals.slice(1), values: parsed.values }
}

export class ConfigApiClient {
  constructor(baseUrl = DEFAULT_URL, fetchImpl = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetchImpl = fetchImpl
    this.csrfToken = undefined
  }

  async csrf() {
    if (this.csrfToken) return this.csrfToken
    const response = await this.fetchImpl(`${this.baseUrl}/feishu-channel`)
    if (!response.ok) throw new Error(`无法打开飞书配置页：HTTP ${response.status}`)
    const html = await response.text()
    const token = html.match(/const csrf='([a-f0-9]+)'/)?.[1]
    if (!token) throw new Error('无法从飞书配置页读取 CSRF token；请确认插件已加载')
    this.csrfToken = token
    return token
  }

  async request(path, { method = 'GET', body, csrf = false } = {}) {
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (csrf) headers['x-feishu-csrf'] = await this.csrf()
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new Error(`无法连接 DSH 本地配置接口 ${this.baseUrl}：${error instanceof Error ? error.message : String(error)}`)
    }
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `配置接口返回 HTTP ${response.status}`)
    }
    return result
  }

  getConfig() {
    return this.request('/feishu-channel/api/config')
  }

  saveConfig(config) {
    return this.request('/feishu-channel/api/config', { method: 'PUT', body: config, csrf: true })
  }

  testCredentials(input = {}) {
    return this.request('/feishu-channel/api/test', { method: 'POST', body: input, csrf: true })
  }
}

export function configUpdate(current, values, appSecret) {
  const next = {
    ...current,
    ...(values['app-id'] === undefined ? {} : { appId: values['app-id'] }),
    ...(values['allow-open-id'] === undefined ? {} : { allowedOpenIds: values['allow-open-id'] }),
    ...(values.workspace === undefined ? {} : { defaultWorkspace: values.workspace }),
    ...(values.ack === undefined ? {} : { acknowledgement: values.ack }),
    ...(values.enable ? { enabled: true } : {}),
    ...(values.disable ? { enabled: false } : {}),
    ...(values['group-at'] ? { allowGroupAt: true } : {}),
    ...(values['no-group-at'] ? { allowGroupAt: false } : {}),
    ...(values.files ? { fileTransferEnabled: true } : {}),
    ...(values['no-files'] ? { fileTransferEnabled: false } : {}),
    ...(values['max-file-mb'] === undefined ? {} : { maxFileSizeMb: Number(values['max-file-mb']) }),
    ...(appSecret === undefined ? {} : { appSecret }),
    ...(values['clear-app-secret'] ? { clearAppSecret: true } : {}),
  }
  return next
}

export function formatConfig(payload) {
  const config = payload.config
  const status = payload.status
  const streamMode = {
    cardkit: '飞书原生流式卡片',
    'text-edit': '文本消息编辑（自动降级）',
    unknown: '尚未执行流式任务',
  }[status.streamMode] || status.streamMode || '未知'
  return [
    `插件状态: ${status.state}${status.detail ? ` (${status.detail})` : ''}`,
    `流式输出: ${streamMode}`,
    `通道启用: ${config.enabled ? '是' : '否'}`,
    `App ID: ${config.appId || '未配置'}`,
    `App Secret: ${payload.secretConfigured ? '已配置（不回显）' : '未配置'}`,
    `允许用户: ${config.allowedOpenIds.length ? config.allowedOpenIds.join(', ') : '空（私聊默认允许，群聊拒绝）'}`,
    `默认工作目录: ${config.defaultWorkspace}`,
    `群聊 @机器人: ${config.allowGroupAt ? '允许' : '禁用'}`,
    `文件传输: ${config.fileTransferEnabled ? `允许（单文件 ${config.maxFileSizeMb} MB）` : '禁用'}`,
    `文件资源权限: ${status.fileResourceGranted === true ? '已授权' : status.fileResourceGranted === false ? '未授权（需要 im:resource）' : '未知'}`,
    `处理中提示: ${config.acknowledgement || '关闭'}`,
  ].join('\n')
}

export const HELP_TEXT = `DSH 飞书通道 CLI

用法：dsh-feishu-config <命令> [选项]

命令：
  show                         查看配置和连接状态
  configure                    交互式配置（保存后确认是否启用）
  set                          非交互修改配置
  test                         测试 App ID / App Secret
  enable                       测试凭据并启用通道（明确确认）
  disable                      停用通道
  allow add <ou_xxx...>        添加允许用户
  allow remove <ou_xxx...>     移除允许用户

set/test 选项：
  --app-id <cli_xxx>           设置 App ID
  --app-secret-stdin           从 stdin 安全读取 App Secret
  --clear-app-secret           清除保存的 App Secret
  --allow-open-id <ou_xxx>     替换白名单，可重复
  --workspace <绝对路径>       设置默认工作目录
  --ack <文本>                 设置处理中提示，空字符串可关闭
  --enable | --disable         保存时启停通道
  --group-at | --no-group-at   允许或禁止群聊 @机器人
  --files | --no-files         允许或禁止文件传输
  --max-file-mb <1-30>         设置单个文件大小上限
  --url <URL>                  本地 DSH 地址，默认 ${DEFAULT_URL}

示例：
  dsh-feishu-config show
  dsh-feishu-config configure
  printf '%s' "$FEISHU_SECRET" | dsh-feishu-config set --app-id cli_xxx --app-secret-stdin
  dsh-feishu-config allow add ou_xxx
  dsh-feishu-config enable
`
