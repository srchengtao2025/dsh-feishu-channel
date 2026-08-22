import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeWebUiRequest, buildUpstreamHeaders, parseWebUiCommand, WebUiTunnelManager } from '../src/webui-tunnel.js'

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

test('webui proxy cookie lifetime follows the requested tunnel lifetime', () => {
  const auth = authorizeWebUiRequest({ url: '/token/', headers: {} }, 'token', 15 * 60)
  assert.match(auth.setCookie, /Max-Age=900/)
})

test('webui proxy normalizes browser origin metadata for loopback DSH', () => {
  const headers = buildUpstreamHeaders({
    host: 'random.trycloudflare.com',
    origin: 'https://random.trycloudflare.com',
    referer: 'https://random.trycloudflare.com/chat?id=1',
    forwarded: 'host=random.trycloudflare.com',
    'x-forwarded-host': 'random.trycloudflare.com',
  }, 3080, 'Upgrade')

  assert.equal(headers.host, '127.0.0.1:3080')
  assert.equal(headers.origin, 'http://127.0.0.1:3080')
  assert.equal(headers.referer, 'http://127.0.0.1:3080/chat?id=1')
  assert.equal(headers.connection, 'Upgrade')
  assert.equal(headers.forwarded, undefined)
  assert.equal(headers['x-forwarded-host'], undefined)
})

test('webui manager discovers cloudflared from PATH by default', () => {
  const manager = new WebUiTunnelManager()
  assert.equal(manager.cloudflaredPath, process.env.DSH_CLOUDFLARED_PATH || 'cloudflared')
})
