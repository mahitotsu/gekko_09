import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cart } from '../src/cart.js'

test('adding to an existing line counts the cart correctly', () => {
  const c = new Cart()
  c.add('a', 100, 30)
  c.add('a', 100, 15)
  assert.equal(c.count(), 45)
  c.add('b', 100, 5)
  assert.equal(c.count(), 50)
})

test('a rejected add leaves the cart unchanged', () => {
  const c = new Cart()
  c.add('a', 100, 45)
  assert.throws(() => c.add('a', 100, 10), /full/)
  assert.equal(c.count(), 45)
  assert.throws(() => c.add('z', 100, 6), /full/)
  assert.equal(c.count(), 45)
  assert.equal(c.subtotal(), 4500)
})
