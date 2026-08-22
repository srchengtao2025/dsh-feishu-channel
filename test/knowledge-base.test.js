import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chunkKnowledgeDocument,
  KnowledgeBaseManager,
  parseWikiUrl,
  searchKnowledgeChunks,
} from '../src/knowledge-base.js'

test('wiki URLs are restricted to Feishu and Lark wiki nodes', () => {
  assert.deepEqual(parseWikiUrl('https://tenant.larksuite.com/wiki/abc123'), {
    domain: 'lark',
    token: 'abc123',
    origin: 'https://tenant.larksuite.com',
  })
  assert.throws(() => parseWikiUrl('https://example.com/wiki/abc123'), /飞书或 Lark/)
})

test('knowledge chunks can be searched with Chinese terms and source metadata', () => {
  const chunks = chunkKnowledgeDocument({
    nodeToken: 'node-1',
    title: '产品手册',
    url: 'https://tenant.larksuite.com/wiki/node-1',
    content: '这是 RezeAI 产品手册。企业版支持知识库检索和权限控制。',
  })
  const results = searchKnowledgeChunks(chunks, '知识库权限', 3)
  assert.equal(results.length, 1)
  assert.equal(results[0].title, '产品手册')
  assert.match(results[0].excerpt, /知识库检索和权限控制/)
})

test('knowledge manager keeps the readable root document when space traversal is denied', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-test-'))
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    if (String(url).includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 })
    if (String(url).includes('/spaces/get_node')) return Response.json({ code: 0, data: { node: {
      title: '首页', space_id: 'space-1', node_token: 'root-token', obj_type: 'docx', obj_token: 'doc-1', has_child: false,
    } } })
    if (String(url).includes('/spaces/space-1/nodes')) return Response.json({ code: 131006, msg: 'permission denied' }, { status: 400 })
    if (String(url).includes('/documents/doc-1/raw_content')) return Response.json({ code: 0, data: { content: '内部知识：首页说明与产品规则。' } })
    throw new Error(`unexpected request: ${url}`)
  }
  const manager = new KnowledgeBaseManager({ fetchImpl, logger: { warn() {} } })
  try {
    const status = await manager.configure({
      appId: 'cli_0123456789abcdef',
      domain: 'lark',
      defaultWorkspace: workspace,
      knowledgeBaseEnabled: true,
      knowledgeBaseUrl: 'https://tenant.larksuite.com/wiki/root-token',
      knowledgeBaseSyncMinutes: 15,
      knowledgeBaseMaxResults: 5,
    }, 'secret')
    assert.equal(status.state, 'partial')
    assert.equal(status.documentCount, 1)
    assert.equal(manager.search('产品规则').results[0].nodeToken, 'root-token')
    assert.equal(manager.read('root-token').title, '首页')
    assert.ok(calls.some(url => url.includes('/spaces/space-1/nodes')))
  } finally {
    manager.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
