import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cart } from '../src/cart.js'
import { parseCsv } from '../src/csv.js'
import { businessDaysBetween } from '../src/dates.js'
import { formatYen } from '../src/money.js'
import { salesReport } from '../src/report.js'

test('formatYen groups thousands', () => {
  assert.equal(formatYen(1234567), '¥1,234,567')
  assert.equal(formatYen(0), '¥0')
})

test('cart counts and totals', () => {
  const c = new Cart()
  c.add('a', 100, 2)
  c.add('b', 300)
  assert.equal(c.count(), 3)
  assert.equal(c.subtotal(), 500)
  assert.equal(c.total(), 550)
})

test('parseCsv splits rows', () => {
  assert.deepEqual(parseCsv('a,b\nc,d\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
})

test('businessDaysBetween skips weekends', () => {
  assert.equal(businessDaysBetween('2026-10-05', '2026-10-12'), 5)
})

test('salesReport totals', () => {
  assert.equal(salesReport([{ name: 'x', amount: 1000 }]), 'x: ¥1,000\nTOTAL: ¥1,000')
})
