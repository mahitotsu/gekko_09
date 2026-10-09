import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addTax } from '../src/money.js'

test('addTax rounds half up to the nearest yen', () => {
  assert.equal(addTax(105), 116) // 115.5
  assert.equal(addTax(101), 111) // 111.1
  assert.equal(addTax(109), 120) // 119.9
  assert.equal(addTax(500), 550)
  assert.equal(addTax(100, 0.08), 108)
})
