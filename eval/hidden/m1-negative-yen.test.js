import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatYen } from '../src/money.js'

test('negative amounts put the sign before the yen mark', () => {
  assert.equal(formatYen(-1200), '-¥1,200')
  assert.equal(formatYen(-5), '-¥5')
  assert.equal(formatYen(-1234567), '-¥1,234,567')
  assert.equal(formatYen(1200), '¥1,200')
})
