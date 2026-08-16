import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeWebUiRequest, parseWebUiCommand } from '../src/webui-tunnel.js'

test('webui command parses default, bounded ttl and lifecycle commands', () => {
  assert.deepEqual(parseWebUiCommand('/webui'), { kind: 'start', minutes: 30 })
  assert.deepEqual(parseWebUiCommand('/webui 15m'), { kind: 'start', minutes: 15 })
  assert.deepEqual(parseWebUiCommand('/webui status'), { kind: 'status' })
  assert.deepEqual(parseWebUiCommand('/webui stop'), { kind: 'stop' })
  assert.deepEqual(parseWebUiCommand('/webui 90'), { kind: 'invalid', message: '有效期只能设置为 1-60 分钟。' })
  assert.equal(parseWebUiCommand('webui'), undefined)
})

test('webui proxy requires the random path once, then a secure cookie', () => {
  const token = 'abc123'
  const first = authorizeWebUiRequest({ url: `/${token}/`, headers: {} }, token)
  assert.equal(first.allowed, true)
  assert.equal(first.path, '/')
  assert.match(first.setCookie, /HttpOnly/)
  assert.equal(authorizeWebUiRequest({ url: '/', headers: {} }, token).allowed, false)
  assert.equal(authorizeWebUiRequest({ url: '/api/test', headers: { cookie: `dsh_webui=${token}` } }, token).allowed, true)
  assert.equal(authorizeWebUiRequest({ url: '/api/test', headers: { cookie: 'dsh_webui=wrong' } }, token).allowed, false)
})
