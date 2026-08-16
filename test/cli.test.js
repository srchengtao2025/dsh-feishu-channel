import test from 'node:test'
import assert from 'node:assert/strict'
import { ConfigApiClient, configUpdate, formatConfig, parseCliArgs } from '../src/cli-core.js'

test('CLI parses repeated allowlist and mutually exclusive switches', () => {
  const parsed = parseCliArgs(['set', '--allow-open-id', 'ou_a', '--allow-open-id', 'ou_b', '--enable'])
  assert.equal(parsed.command, 'set')
  assert.deepEqual(parsed.values['allow-open-id'], ['ou_a', 'ou_b'])
  assert.equal(parsed.values.enable, true)
  assert.throws(() => parseCliArgs(['set', '--enable', '--disable']), /不能同时/)
  assert.throws(() => parseCliArgs(['set', '--files', '--no-files']), /不能同时/)
})

test('configUpdate preserves unspecified settings and never invents a secret', () => {
  const current = {
    enabled: false, appId: 'cli_0123456789abcdef', allowedOpenIds: ['ou_a'],
    defaultWorkspace: '/work', allowGroupAt: false, acknowledgement: 'ok',
  }
  assert.deepEqual(configUpdate(current, { enable: true }, undefined), { ...current, enabled: true })
  assert.deepEqual(configUpdate(current, { 'allow-open-id': ['ou_b'] }, 'secret'), {
    ...current, allowedOpenIds: ['ou_b'], appSecret: 'secret',
  })
  assert.equal(configUpdate(current, { files: true, 'max-file-mb': '12' }).maxFileSizeMb, 12)
})

test('config output reports the active streaming transport', () => {
  const output = formatConfig({
    config: {
      enabled: true,
      appId: 'cli_test',
      allowedOpenIds: [],
      defaultWorkspace: '/opt/deepseek-harness',
      allowGroupAt: false,
      acknowledgement: '',
    },
    secretConfigured: true,
    status: { state: 'connected', detail: '', streamMode: 'text-edit' },
  })
  assert.match(output, /流式输出: 文本消息编辑（自动降级）/)
})

test('ConfigApiClient obtains CSRF and does not expose secret values', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/feishu-channel')) {
      return { ok: true, text: async () => "<script>const csrf='abc123';</script>" }
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        config: { enabled: false, appId: '', allowedOpenIds: [], defaultWorkspace: '/work', allowGroupAt: false, acknowledgement: '' },
        secretConfigured: false,
        status: { state: 'disabled' },
      }),
    }
  }
  const client = new ConfigApiClient('http://127.0.0.1:3080/', fetchImpl)
  await client.saveConfig({ enabled: false })
  assert.equal(calls[1].options.headers['x-feishu-csrf'], 'abc123')
  assert.match(formatConfig(await client.getConfig()), /App Secret: 未配置/)
})
