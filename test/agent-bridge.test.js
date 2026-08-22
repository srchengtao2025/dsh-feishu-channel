import test from 'node:test'
import assert from 'node:assert/strict'
import { stableFeishuSessionId } from '../src/session-id.js'

test('stable Feishu sessions are isolated by agent preset', () => {
  const standard = stableFeishuSessionId('chat-1', 'standard')
  const minimal = stableFeishuSessionId('chat-1', 'minimal')

  assert.equal(standard, stableFeishuSessionId('chat-1', 'standard'))
  assert.notEqual(standard, minimal)
  assert.match(standard, /^feishu-v3-[a-f0-9]{24}$/)
})
