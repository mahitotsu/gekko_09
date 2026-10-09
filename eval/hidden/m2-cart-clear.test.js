import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cart } from '../src/cart.js'

test('clear empties lines and coupons', () => {
  const c = new Cart()
  c.add('a', 100, 3)
  c.applyCoupon('X', 10)
  c.clear()
  assert.equal(c.count(), 0)
  assert.equal(c.subtotal(), 0)
  c.add('b', 1000)
  assert.equal(c.total(), 1100) // the coupon is gone too
})
