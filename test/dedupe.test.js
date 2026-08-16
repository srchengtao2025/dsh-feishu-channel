import test from 'node:test'
import assert from 'node:assert/strict'
import { ExpiringDedupe } from '../src/dedupe.js'

test('dedupe remembers a message until its ttl expires', () => {
  let now = 100
  const dedupe = new ExpiringDedupe({ ttlMs: 50, now: () => now })
  assert.equal(dedupe.seen('m1'), false)
  assert.equal(dedupe.seen('m1'), true)
  now = 151
  assert.equal(dedupe.seen('m1'), false)
})
