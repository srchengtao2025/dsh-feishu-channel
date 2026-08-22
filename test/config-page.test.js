import test from 'node:test'
import assert from 'node:assert/strict'
import { renderConfigPage } from '../src/config-page.js'

test('rendered config page contains valid inline JavaScript', () => {
  const html = renderConfigPage('test-csrf')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]

  assert.equal(scripts.length, 1)
  assert.doesNotThrow(() => new Function(scripts[0][1]))
})
