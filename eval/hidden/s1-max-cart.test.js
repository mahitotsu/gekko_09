import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cart } from '../src/cart.js'
import { MAX_CART_ITEMS } from '../src/config.js'

test('the cart holds up to 100 items', () => {
  assert.equal(MAX_CART_ITEMS, 100)
  const c = new Cart()
  c.add('a', 100, 100)
  assert.equal(c.count(), 100)
  assert.throws(() => c.add('b', 100, 1), /full/)
})
