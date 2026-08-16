import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { isSameOrigin, readJson, validCsrf } from '../src/http.js'

function request(body, headers = {}) {
  const req = Readable.from([Buffer.from(body)])
  req.headers = headers
  return req
}

test('readJson enforces content type and parses a bounded body', async () => {
  await assert.rejects(() => readJson(request('{}')), /Content-Type/)
  const parsed = await readJson(request('{"enabled":true}', { 'content-type': 'application/json' }))
  assert.deepEqual(parsed, { enabled: true })
})

test('configuration requests are limited to loopback same-origin hosts', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true)
  assert.equal(isSameOrigin({ headers: { host: 'example.com' } }), false)
  assert.equal(isSameOrigin({ headers: { host: 'localhost:3080', origin: 'https://evil.test' } }), false)
})

test('csrf comparison rejects missing and mismatched values', () => {
  assert.equal(validCsrf({ headers: { 'x-feishu-csrf': 'abc' } }, 'abc'), true)
  assert.equal(validCsrf({ headers: { 'x-feishu-csrf': 'abd' } }, 'abc'), false)
  assert.equal(validCsrf({ headers: {} }, 'abc'), false)
})
