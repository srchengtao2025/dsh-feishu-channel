import test from 'node:test'
import assert from 'node:assert/strict'
import { installAgentModelSelection } from '../src/model-selection.js'

test('model selection populates prompt variables and the outbound request', async () => {
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const selection = {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    assembled: undefined,
  }
  const dispose = installAgentModelSelection(ctx, selection)

  const assembly = await listeners.get('system-prompt/assemble')({}, {}, async () => ({ sections: [], variables: {} }))
  assert.deepEqual(assembly.variables, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })

  const request = await listeners.get('agent/request')({}, async () => ({ provider: 'old', model: 'old', reasoningEffort: 'low' }))
  assert.deepEqual(request, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })

  dispose()
  assert.equal(listeners.size, 0)
})
