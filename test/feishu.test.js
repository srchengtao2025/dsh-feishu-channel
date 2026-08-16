import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { testFeishuCredentials, TextEditStreamController } from '../src/feishu.js'

test('credential test sends secrets only in the request body', async () => {
  let request
  const result = await testFeishuCredentials({
    appId: 'cli_0123456789abcdef',
    appSecret: 'secret-value',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => ({ code: 0, expire: 7200 }) }
    },
  })
  assert.deepEqual(result, { ok: true, expire: 7200 })
  assert.equal(request.options.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(request.options.body), {
    app_id: 'cli_0123456789abcdef', app_secret: 'secret-value',
  })
})

test('credential test redacts token response and reports API errors', async () => {
  await assert.rejects(() => testFeishuCredentials({
    appId: 'cli_0123456789abcdef',
    appSecret: 'bad',
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 10003, msg: 'app secret invalid' }) }),
  }), /app secret invalid/)
})

test('text edit stream throttles updates and reserves the final edit', async () => {
  const edits = []
  const controller = new TextEditStreamController({
    initialText: 'start', throttleMs: 2, maxEdits: 3,
    edit: async text => edits.push(text),
  })
  await controller.setContent('one')
  await delay(5)
  await controller.setContent('two')
  await delay(5)
  await controller.setContent('final')
  await delay(5)
  await controller.flush()
  assert.deepEqual(edits, ['one', 'two', 'final'])
})
