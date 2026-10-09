import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as dates from '../src/dates.js'

const { businessDaysBetween, addBusinessDays } = dates

test('existing calls keep working', () => {
  assert.equal(businessDaysBetween('2026-10-05', '2026-10-12'), 5)
})

test('weekday holidays are skipped', () => {
  // 2026-10-12 (Mon) is a holiday
  assert.equal(businessDaysBetween('2026-10-05', '2026-10-19', ['2026-10-12']), 9)
})

test('holidays on weekends are not subtracted twice', () => {
  assert.equal(businessDaysBetween('2026-10-05', '2026-10-12', ['2026-10-10']), 5)
})

test('addBusinessDays moves forward over weekends and holidays', () => {
  assert.equal(typeof addBusinessDays, 'function')
  assert.equal(addBusinessDays('2026-10-09', 1), '2026-10-12') // Fri + 1 -> Mon
  assert.equal(addBusinessDays('2026-10-09', 1, ['2026-10-12']), '2026-10-13')
  assert.equal(addBusinessDays('2026-10-05', 0), '2026-10-05')
})
