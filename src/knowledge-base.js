import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const API_DOMAINS = Object.freeze({
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
})
const MAX_DOCUMENTS = 500
const MAX_INDEX_CHARS = 2_000_000
const CHUNK_CHARS = 1_000
const CHUNK_OVERLAP = 120

export function parseWikiUrl(value) {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    throw new Error('知识库链接格式无效')
  }
  const domain = url.hostname.endsWith('.larksuite.com')
    ? 'lark'
    : url.hostname.endsWith('.feishu.cn')
      ? 'feishu'
      : undefined
  const token = url.pathname.match(/^\/wiki\/([A-Za-z0-9_-]+)\/?$/)?.[1]
  if (!domain || !token) throw new Error('知识库链接必须是飞书或 Lark 的 /wiki/<token> 地址')
  return { domain, token, origin: url.origin }
}

export function chunkKnowledgeDocument(document, chunkChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const content = String(document.content ?? '').replace(/\r\n?/g, '\n').trim()
  if (!content) return []
  const chunks = []
  let offset = 0
  while (offset < content.length) {
    let end = Math.min(content.length, offset + chunkChars)
    if (end < content.length) {
      const boundary = Math.max(content.lastIndexOf('\n', end), content.lastIndexOf('。', end), content.lastIndexOf('.', end))
      if (boundary > offset + Math.floor(chunkChars * 0.55)) end = boundary + 1
    }
    const text = content.slice(offset, end).trim()
    if (text) chunks.push({
      id: `${document.nodeToken}:${chunks.length}`,
      nodeToken: document.nodeToken,
      title: document.title,
      url: document.url,
      text,
    })
    if (end >= content.length) break
    offset = Math.max(offset + 1, end - overlap)
  }
  return chunks
}

function searchTerms(query) {
  const normalized = String(query ?? '').trim().toLowerCase()
  const terms = new Set(normalized.match(/[a-z0-9_-]{2,}|[\p{Script=Han}]/gu) ?? [])
  const han = [...normalized].filter(char => /\p{Script=Han}/u.test(char))
  for (let index = 0; index < han.length - 1; index += 1) terms.add(`${han[index]}${han[index + 1]}`)
  return { normalized, terms: [...terms].filter(term => term.length > 0) }
}

function occurrences(text, term) {
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(term, offset)) >= 0) {
    count += 1
    offset += Math.max(1, term.length)
  }
  return count
}

function excerpt(text, query, maxChars = 520) {
  if (text.length <= maxChars) return text
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  const start = Math.max(0, index >= 0 ? index - Math.floor(maxChars / 3) : 0)
  const end = Math.min(text.length, start + maxChars)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function searchKnowledgeChunks(chunks, query, limit = 5) {
  const { normalized, terms } = searchTerms(query)
  if (!normalized) throw new Error('知识库检索词不能为空')
  return chunks.map(chunk => {
    const title = chunk.title.toLowerCase()
    const text = chunk.text.toLowerCase()
    let score = title.includes(normalized) ? 40 : 0
    score += text.includes(normalized) ? 25 : 0
    for (const term of terms) {
      score += occurrences(title, term) * 6
      score += Math.min(occurrences(text, term), 8)
    }
    return { chunk, score }
  }).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)))
    .map(({ chunk, score }) => ({
      nodeToken: chunk.nodeToken,
      title: chunk.title,
      url: chunk.url,
      excerpt: excerpt(chunk.text, normalized),
      score,
    }))
}

export class LarkKnowledgeClient {
  constructor({ domain, appId, appSecret, fetchImpl = fetch }) {
    this.baseUrl = API_DOMAINS[domain]
    this.appId = appId
    this.appSecret = appSecret
    this.fetchImpl = fetchImpl
    this.accessToken = undefined
    this.accessTokenExpiresAt = 0
  }

  async tenantToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken
    const response = await this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`知识库鉴权失败：${body.msg || `HTTP ${response.status}`}`)
    }
    this.accessToken = body.tenant_access_token
    this.accessTokenExpiresAt = Date.now() + Math.max(60, Number(body.expire || 7200) - 60) * 1000
    return this.accessToken
  }

  async request(path) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${await this.tenantToken()}` },
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.code !== 0) {
      const error = new Error(body.msg || `HTTP ${response.status}`)
      error.code = body.code
      error.httpStatus = response.status
      throw error
    }
    return body.data ?? {}
  }

  resolveNode(token) {
    return this.request(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`).then(data => data.node)
  }

  async listNodePage(spaceId, parentNodeToken, pageToken) {
    const params = new URLSearchParams({ page_size: '50' })
    if (parentNodeToken) params.set('parent_node_token', parentNodeToken)
    if (pageToken) params.set('page_token', pageToken)
    return this.request(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${params}`)
  }

  async listSpaceNodes(spaceId) {
    const nodes = []
    const parents = [undefined]
    while (parents.length > 0 && nodes.length < MAX_DOCUMENTS) {
      const parent = parents.shift()
      let pageToken
      do {
        const page = await this.listNodePage(spaceId, parent, pageToken)
        for (const node of page.items ?? []) {
          nodes.push(node)
          if (node.has_child) parents.push(node.node_token)
          if (nodes.length >= MAX_DOCUMENTS) break
        }
        pageToken = page.has_more ? page.page_token : undefined
      } while (pageToken && nodes.length < MAX_DOCUMENTS)
    }
    return nodes
  }

  async readDocument(node) {
    if (node.obj_type !== 'docx') return undefined
    const data = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(node.obj_token)}/raw_content`)
    return String(data.content ?? '')
  }
}

export class KnowledgeBaseManager {
  constructor({ logger, fetchImpl = fetch } = {}) {
    this.logger = logger ?? console
    this.fetchImpl = fetchImpl
    this.timer = undefined
    this.config = undefined
    this.client = undefined
    this.documents = []
    this.chunks = []
    this.state = { state: 'disabled', detail: '知识库检索未启用' }
  }

  snapshot() {
    return {
      ...this.state,
      documentCount: this.documents.length,
      chunkCount: this.chunks.length,
    }
  }

  async configure(config, appSecret) {
    this.close()
    this.config = config
    this.documents = []
    this.chunks = []
    if (!config.knowledgeBaseEnabled) {
      this.state = { state: 'disabled', detail: '知识库检索未启用' }
      return this.snapshot()
    }
    if (!config.appId || !appSecret) {
      this.state = { state: 'error', detail: '知识库同步缺少 App ID 或 App Secret' }
      return this.snapshot()
    }
    this.client = new LarkKnowledgeClient({
      domain: config.domain,
      appId: config.appId,
      appSecret,
      fetchImpl: this.fetchImpl,
    })
    await this.loadIndex()
    await this.sync().catch(error => {
      this.state = {
        state: this.chunks.length ? 'stale' : 'error',
        detail: `知识库同步失败：${error instanceof Error ? error.message : String(error)}`,
      }
      this.logger.warn(this.state.detail)
    })
    this.timer = setInterval(() => {
      this.sync().catch(error => {
        this.state = { state: this.chunks.length ? 'stale' : 'error', detail: `知识库同步失败：${error.message}` }
        this.logger.warn(this.state.detail)
      })
    }, config.knowledgeBaseSyncMinutes * 60_000)
    this.timer.unref?.()
    return this.snapshot()
  }

  indexPath() {
    return join(this.config.defaultWorkspace, '.dsh-feishu', 'knowledge-index.json')
  }

  async loadIndex() {
    try {
      const saved = JSON.parse(await readFile(this.indexPath(), 'utf8'))
      if (saved.knowledgeBaseUrl !== this.config.knowledgeBaseUrl) return
      this.documents = Array.isArray(saved.documents) ? saved.documents : []
      this.chunks = this.documents.flatMap(document => chunkKnowledgeDocument(document))
      this.state = { state: 'stale', detail: '已加载本地知识库索引，正在刷新', lastSyncedAt: saved.lastSyncedAt }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn(`读取知识库索引失败：${error.message}`)
    }
  }

  async persistIndex(lastSyncedAt) {
    const filename = this.indexPath()
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({
      version: 1,
      knowledgeBaseUrl: this.config.knowledgeBaseUrl,
      lastSyncedAt,
      documents: this.documents,
    })}\n`, { mode: 0o600 })
    await rename(temporary, filename)
  }

  async sync() {
    if (!this.client || !this.config?.knowledgeBaseEnabled) return this.snapshot()
    this.state = { state: 'syncing', detail: '正在同步知识库' }
    const parsed = parseWikiUrl(this.config.knowledgeBaseUrl)
    const root = await this.client.resolveNode(parsed.token)
    if (!root) throw new Error('知识库入口节点不存在')

    let nodes = [root]
    let warning
    try {
      const spaceNodes = await this.client.listSpaceNodes(root.space_id)
      const byToken = new Map([root, ...spaceNodes].map(node => [node.node_token, node]))
      nodes = [...byToken.values()]
    } catch (error) {
      warning = `当前应用只能读取入口文档，尚无整个知识空间的遍历权限：${error.message}`
    }

    const documents = []
    let totalChars = 0
    for (const node of nodes.slice(0, MAX_DOCUMENTS)) {
      let content
      try {
        content = await this.client.readDocument(node)
      } catch (error) {
        this.logger.warn(`跳过无法读取的知识库文档 ${node.title || node.node_token}：${error.message}`)
        continue
      }
      if (!content) continue
      const remaining = MAX_INDEX_CHARS - totalChars
      if (remaining <= 0) break
      content = content.slice(0, remaining)
      totalChars += content.length
      documents.push({
        nodeToken: node.node_token,
        title: node.title || '未命名文档',
        url: `${parsed.origin}/wiki/${node.node_token}`,
        content,
      })
    }
    if (documents.length === 0) throw new Error('没有读取到可索引的新版文档内容')
    this.documents = documents
    this.chunks = documents.flatMap(document => chunkKnowledgeDocument(document))
    const lastSyncedAt = Date.now()
    await this.persistIndex(lastSyncedAt)
    this.state = {
      state: warning ? 'partial' : 'ready',
      detail: warning || `知识库同步完成：${documents.length} 篇文档`,
      lastSyncedAt,
    }
    return this.snapshot()
  }

  search(query, topK = this.config?.knowledgeBaseMaxResults ?? 5) {
    if (!this.config?.knowledgeBaseEnabled) throw new Error('知识库检索未启用')
    if (this.chunks.length === 0) throw new Error(this.state.detail || '知识库索引尚不可用')
    return {
      query: String(query),
      results: searchKnowledgeChunks(this.chunks, query, topK),
      indexState: this.state.state,
    }
  }

  read(nodeToken) {
    if (!this.config?.knowledgeBaseEnabled) throw new Error('知识库检索未启用')
    const document = this.documents.find(item => item.nodeToken === nodeToken)
    if (!document) throw new Error('指定文档不在当前知识库索引中')
    return {
      nodeToken: document.nodeToken,
      title: document.title,
      url: document.url,
      content: document.content.slice(0, 16_000),
      truncated: document.content.length > 16_000,
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.client = undefined
  }
}
