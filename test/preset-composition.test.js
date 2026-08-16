import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDefaultAgentPreset } from '../src/preset-composition.js'

test('default agent preset is resolved and mounted into the agent scope', async () => {
  const calls = []
  const presets = {
    async resolve(id) {
      calls.push(['resolve', id])
      return { id: 'standard' }
    },
    async mount(ctx, id) {
      calls.push(['mount', ctx, id])
    },
  }
  const composition = await resolveDefaultAgentPreset(presets)
  const agentCtx = { id: 'agent-scope' }
  await composition.mount(agentCtx)
  assert.equal(composition.id, 'standard')
  assert.deepEqual(calls, [['resolve', undefined], ['mount', agentCtx, 'standard']])
})
