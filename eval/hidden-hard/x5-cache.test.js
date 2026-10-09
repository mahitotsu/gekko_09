import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TtlCache } from '../src/cache.js'

const make = (opts = {}) => {
  const clock = { t: 0 }
  const log = []
  const cache = new TtlCache({ now: () => clock.t, onEvict: (k, v, r) => log.push(`${k}:${v}:${r}`), ...opts })
  return { cache, clock, log }
}

test('evicts the least recently used past maxEntries', () => {
  const { cache, log } = make({ maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.deepEqual(log, ['b:2:capacity'])
  assert.deepEqual(cache.keys(), ['a', 'c'])
})

test('peek and has do not refresh recency', () => {
  const { cache, log } = make({ maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.peek('a'), 1)
  assert.equal(cache.has('a'), true)
  cache.set('c', 3)
  assert.deepEqual(log, ['a:1:capacity'])
})

test('entries expire at ttl and get does not extend it', () => {
  const { cache, clock, log } = make({ ttlMs: 100 })
  cache.set('a', 1)
  clock.t = 99
  assert.equal(cache.get('a'), 1)
  clock.t = 100
  assert.equal(cache.get('a'), undefined)
  assert.deepEqual(log, ['a:1:expired'])
  cache.set('b', 2)
  clock.t = 150
  assert.equal(cache.get('b'), 2)
  clock.t = 200
  assert.equal(cache.get('b'), undefined)
})

test('per-entry ttl overrides the default', () => {
  const { cache, clock, log } = make()
  cache.set('a', 1, { ttlMs: 10 })
  cache.set('b', 2)
  clock.t = 10
  assert.equal(cache.has('a'), false)
  assert.equal(cache.has('b'), true)
  assert.deepEqual(log, ['a:1:expired'])
})

test('replacing a live entry reports replaced, an expired one expired', () => {
  const { cache, clock, log } = make({ ttlMs: 10 })
  cache.set('a', 1)
  cache.set('a', 2)
  assert.deepEqual(log, ['a:1:replaced'])
  assert.equal(cache.get('a'), 2)
  clock.t = 20
  cache.set('a', 3)
  assert.deepEqual(log, ['a:1:replaced', 'a:2:expired'])
})

test('expired entries do not count toward maxEntries', () => {
  const { cache, clock, log } = make({ maxEntries: 2 })
  cache.set('x', 0, { ttlMs: 10 })
  cache.set('a', 1)
  clock.t = 20
  cache.set('b', 2)
  assert.deepEqual(log, [])
  cache.set('c', 3)
  assert.deepEqual(log, ['x:0:expired', 'a:1:capacity'])
  assert.deepEqual(cache.keys(), ['b', 'c'])
})

test('delete', () => {
  const { cache, clock, log } = make()
  cache.set('a', 1)
  cache.set('b', 2, { ttlMs: 5 })
  assert.equal(cache.delete('a'), true)
  assert.equal(cache.delete('a'), false)
  clock.t = 5
  assert.equal(cache.delete('b'), false)
  assert.deepEqual(log, ['a:1:deleted', 'b:2:expired'])
})

test('keys and size purge expired entries oldest first', () => {
  const { cache, clock, log } = make({ ttlMs: 10 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  cache.get('a')
  assert.deepEqual(cache.keys(), ['b', 'c', 'a'])
  assert.equal(cache.size, 3)
  clock.t = 10
  assert.equal(cache.size, 0)
  assert.deepEqual(log, ['b:2:expired', 'c:3:expired', 'a:1:expired'])
})
