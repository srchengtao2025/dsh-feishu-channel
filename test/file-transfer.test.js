import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { FileTransferManager, parseFileCommand, sanitizeFileName } from '../src/file-transfer.js'

test('file commands and names are parsed without allowing path components', () => {
  assert.deepEqual(parseFileCommand('/file send reports/final.pdf'), { kind: 'send', path: 'reports/final.pdf' })
  assert.deepEqual(parseFileCommand('/files'), { kind: 'list' })
  assert.equal(sanitizeFileName('../../bad:name.txt'), 'bad_name.txt')
})

test('received files are isolated and attached to exactly the next task', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-feishu-files-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const manager = new FileTransferManager({
    openResource: async () => Readable.from([Buffer.from('hello')]),
    sendFile: async () => undefined,
  })
  const message = {
    messageId: 'om_1', chatId: 'oc_1', resource: { type: 'file', fileKey: 'key', fileName: '../report.txt' },
  }
  const record = await manager.receive(message, {
    fileTransferEnabled: true, maxFileSizeMb: 1, defaultWorkspace: workspace,
  })
  assert.equal(await readFile(record.path, 'utf8'), 'hello')
  assert.equal(record.name, 'report.txt')
  const attached = manager.attachPending({ chatId: 'oc_1', text: '总结文件' })
  assert.match(attached.text, /未信任输入/)
  assert.match(attached.text, /report\.txt/)
  assert.equal(manager.pendingFiles('oc_1').length, 0)
})

test('outgoing files must resolve inside the workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-out-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'ok.txt'), 'ok')
  await writeFile(join(root, 'outside.txt'), 'no')
  t.after(() => rm(root, { recursive: true, force: true }))
  const sent = []
  const manager = new FileTransferManager({ openResource: async () => undefined, sendFile: async (_message, file) => sent.push(file) })
  const file = await manager.send({ chatId: 'oc_1' }, workspace, 'ok.txt', 1)
  assert.equal(file.name, 'ok.txt')
  assert.equal(sent.length, 1)
  await assert.rejects(() => manager.send({ chatId: 'oc_1' }, workspace, '../outside.txt', 1), /工作目录内/)
})

test('received files stop at the configured byte limit', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-feishu-limit-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const manager = new FileTransferManager({
    openResource: async () => Readable.from([Buffer.alloc(1024 * 1024 + 1)]),
    sendFile: async () => undefined,
  })
  await assert.rejects(() => manager.receive({
    messageId: 'om_2', chatId: 'oc_2', resource: { type: 'file', fileKey: 'key', fileName: 'large.bin' },
  }, { fileTransferEnabled: true, maxFileSizeMb: 1, defaultWorkspace: workspace }), /超过配置/)
})
