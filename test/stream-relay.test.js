import test from 'node:test'
import assert from 'node:assert/strict'
import { SafeStreamRelay } from '../src/stream-relay.js'

test('safe stream relay emits accumulated snapshots and exact final text', async () => {
  const updates = []
  const relay = new SafeStreamRelay({ setContent: async value => updates.push(value) }, { holdbackChars: 4 })
  relay.push('hello')
  relay.push(' world')
  await relay.complete('hello world')
  assert.deepEqual(updates, ['h', 'hello w', 'hello world'])
})

test('safe stream relay withholds leaked DSML protocol', async () => {
  const updates = []
  const relay = new SafeStreamRelay({ setContent: async value => updates.push(value) }, { holdbackChars: 64 })
  relay.push('正常前缀<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="Bash">')
  await relay.flush()
  assert.equal(updates.some(value => value.includes('DSML')), false)
})
