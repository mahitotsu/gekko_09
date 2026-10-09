import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Inventory, memoryStore } from '../src/inventory.js'

test('concurrent reservations never oversell', async () => {
  const store = memoryStore({ apple: 3 })
  const inv = new Inventory(store)
  const results = await Promise.all(Array.from({ length: 6 }, () => inv.reserve('apple', 1)))
  assert.equal(results.filter(Boolean).length, 3)
  assert.equal(await store.get('apple'), 0)
})

test('reserve and release interleave correctly', async () => {
  const store = memoryStore({ pear: 2 })
  const inv = new Inventory(store)
  await Promise.all([inv.reserve('pear', 2), inv.release('pear', 1), inv.reserve('pear', 1)])
  assert.equal(await store.get('pear'), 0)
})

test('different skus do not block each other', async () => {
  const store = memoryStore({ a: 1, b: 1 })
  const inv = new Inventory(store)
  assert.deepEqual(await Promise.all([inv.reserve('a', 1), inv.reserve('b', 1)]), [true, true])
})
