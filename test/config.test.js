import test from 'node:test'
import assert from 'node:assert/strict'
import { isSenderAllowed, normalizeConfig, normalizeOpenIds, resolveConfigSave } from '../src/config.js'
import { removeSection, updateCredential, updateSection } from '../src/model-config.js'

test('normalizeOpenIds removes separators, blanks and duplicates', () => {
  assert.deepEqual(normalizeOpenIds('ou_a, ou_b\nou_a；ou_c'), ['ou_a', 'ou_b', 'ou_c'])
})

test('normalizeConfig rejects unsafe or malformed values', () => {
  const result = normalizeConfig({
    enabled: true,
    appId: 'bad',
    allowedOpenIds: ['bad-user'],
    defaultWorkspace: 'relative/path',
  })
  assert.equal(result.errors.length, 3)
})

test('empty allowlist allows private chat but not group chat', () => {
  assert.equal(isSenderAllowed({ allowedOpenIds: [] }, { openId: 'ou_a', chatType: 'p2p' }), true)
  assert.equal(isSenderAllowed({ allowedOpenIds: [] }, { openId: 'ou_a', chatType: 'group' }), false)
  assert.equal(isSenderAllowed({ allowedOpenIds: ['ou_a'] }, { openId: 'ou_a', chatType: 'p2p' }), true)
  assert.equal(isSenderAllowed({ allowedOpenIds: ['ou_a'] }, { openId: 'ou_b', chatType: 'p2p' }), false)
})

test('enabling requires an explicit confirmation', () => {
  const config = normalizeConfig({ enabled: true, appId: 'cli_0123456789abcdef' }).config
  assert.deepEqual(resolveConfigSave(config), { config: { ...config, enabled: false }, needsEnableConfirmation: true })
  assert.deepEqual(resolveConfigSave(config, true), { config, needsEnableConfirmation: false })
})

test('file transfer limits stay within the bidirectional Feishu maximum', () => {
  assert.equal(normalizeConfig({ maxFileSizeMb: 30 }).errors.length, 0)
  assert.match(normalizeConfig({ maxFileSizeMb: 31 }).errors.join(''), /1 到 30 MB/)
  assert.equal(normalizeConfig({ fileTransferEnabled: false }).config.fileTransferEnabled, false)
})

test('model CLI updates only its own settings section and credential reference', () => {
  const settings = 'feishu-channel:\n  enabled: true\n'
  const next = updateSection(settings, 'agent-default-model', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.match(next, /feishu-channel:\n  enabled: true/)
  assert.match(next, /agent-default-model:\n  provider: "deepseek-official"\n  model: "deepseek-v4-pro"/)
  assert.equal(removeSection(next, 'agent-default-model'), settings)
  assert.match(updateCredential('FEISHU_APP_SECRET: "hidden"\n', 'DEEPSEEK_API_KEY', 'secret'), /DEEPSEEK_API_KEY: "secret"/)
})
