import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cart } from '../src/cart.js'

const cart = () => {
  const c = new Cart()
  c.add('a', 1000)
  return c
}

test('the same coupon code counts once', () => {
  const c = cart()
  c.applyCoupon('SPRING', 10)
  c.applyCoupon('SPRING', 10)
  assert.equal(c.total(), 990) // 1000 * 0.9 * 1.1
})

test('different coupons add up their percentages', () => {
  const c = cart()
  c.applyCoupon('A', 10)
  c.applyCoupon('B', 5)
  assert.equal(c.total(), 935) // 1000 * 0.85 * 1.1
})

test('discount never goes past 100%', () => {
  const c = cart()
  c.applyCoupon('A', 70)
  c.applyCoupon('B', 50)
  assert.equal(c.total(), 0)
})
