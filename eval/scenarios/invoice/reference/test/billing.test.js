import assert from 'node:assert/strict'
import { test } from 'node:test'

import { billingPeriod, invoiceFor, lineAmount, previousMonth, priceRowAt, returnAmount, tax, unitPriceFor } from '../src/billing.js'

test('締め期間: 末締めは暦月、日付締めは前月の締め日の翌日から当月の締め日まで', () => {
  assert.deepEqual(billingPeriod('2026-09', '末'), { start: '2026-09-01', end: '2026-09-30' })
  assert.deepEqual(billingPeriod('2026-09', '20'), { start: '2026-08-21', end: '2026-09-20' })
  assert.deepEqual(billingPeriod('2026-09', '1'), { start: '2026-08-02', end: '2026-09-01' })
  assert.deepEqual(billingPeriod('2027-01', '15'), { start: '2026-12-16', end: '2027-01-15' })
  assert.deepEqual(billingPeriod('2028-02', '末'), { start: '2028-02-01', end: '2028-02-29' })
  assert.deepEqual(billingPeriod('2027-03', '28'), { start: '2027-03-01', end: '2027-03-28' })
  assert.deepEqual(billingPeriod('2028-03', '28'), { start: '2028-02-29', end: '2028-03-28' })
  assert.equal(previousMonth('2027-01'), '2026-12')
})

test('端数処理: 切り捨て、四捨五入（ちょうど .5 は切り上げ）、切り上げ。マイナスは絶対値で丸めて符号を戻す', () => {
  assert.equal(tax(875, 10, '切り捨て'), 87)
  assert.equal(tax(875, 10, '四捨五入'), 88)
  assert.equal(tax(874, 10, '四捨五入'), 87)
  assert.equal(tax(871, 10, '切り上げ'), 88)
  assert.equal(tax(870, 10, '切り上げ'), 87)
  assert.equal(tax(-875, 10, '切り捨て'), -87)
  assert.equal(tax(-875, 10, '四捨五入'), -88)
  assert.equal(tax(-871, 10, '切り上げ'), -88)
  assert.equal(tax(-7405, 10, '切り捨て'), -740)
})

test('価格改定: 注文日の時点で有効な行（適用開始日が注文日以前でもっとも新しい行）を使う', () => {
  const rows = [
    { unit_price: '200', valid_from: '2026-01-01' },
    { unit_price: '230', valid_from: '2026-09-20' },
    { unit_price: '210', valid_from: '2026-09-10' },
  ]
  assert.equal(priceRowAt(rows, '2026-09-09').unit_price, '200')
  assert.equal(priceRowAt(rows, '2026-09-10').unit_price, '210')
  assert.equal(priceRowAt(rows, '2026-09-19').unit_price, '210')
  assert.equal(priceRowAt(rows, '2026-09-20').unit_price, '230')
  assert.equal(priceRowAt(rows, '2025-12-31'), undefined)
})

test('特約店は単価の 10% 引き（1円未満切り捨て）', () => {
  assert.equal(unitPriceFor({ rank: '特約店' }, { unit_price: '333' }), 299)
  assert.equal(unitPriceFor({ rank: '特約店' }, { unit_price: '10100' }), 9090)
  assert.equal(unitPriceFor({ rank: '一般' }, { unit_price: '333' }), 333)
})

test('数量割引は 100 個以上で 5%、割引額は1円未満切り捨て', () => {
  assert.equal(lineAmount(25, 99), 2475)
  assert.equal(lineAmount(25, 100), 2375)
  assert.equal(lineAmount(25, 150), 3563) // 3750 - 187
  assert.equal(lineAmount(99, 120), 11286) // 11880 - 594
})

test('返品の金額: 元の明細の金額 × 返品数量 ÷ 元の数量、1円未満切り捨て、マイナス', () => {
  const line = { amount: 3563, quantity: 150 }
  assert.equal(returnAmount(line, 7), -166) // 166.27
  assert.equal(returnAmount(line, 13), -308) // 308.79
  assert.equal(returnAmount({ amount: 102486, quantity: 120 }, 9), -7686) // 7686.45
  assert.equal(returnAmount({ amount: 4440, quantity: 3 }, 1), -1480)
})

const products = new Map([
  ['P04', [{ product_id: 'P04', name: 'シュレッダー', unit_price: '9999', tax_rate: '10', valid_from: '2026-01-01' }]],
  ['P05', [{ product_id: 'P05', name: '麦茶', unit_price: '1', tax_rate: '8', valid_from: '2026-01-01' }]],
  ['P07', [{ product_id: 'P07', name: '封筒', unit_price: '25', tax_rate: '10', valid_from: '2026-01-01' }]],
])
const customer = { customer_id: 'M1', name: '閾値', closing_day: '末', zone: 'A', rank: '一般', rounding: '' }
const order = (order_id, product_id, quantity, status = '確定', order_date = '2026-09-01') =>
  ({ order_id, order_date, customer_id: 'M1', product_id, quantity: String(quantity), status })
const data = (over = {}) => ({ orders: [], products, returns: [], payments: [], balances: [], ...over })

test('送料: 注文の小計（税抜、税率をまたいで合計）が 10,000 円以上なら無料、未満なら地域の送料を 10% 課税で加える', () => {
  const r = invoiceFor('2026-09', customer, data({ orders: [order('A01', 'P04', 1), order('A02', 'P04', 1), order('A02', 'P05', 1)] }))
  assert.deepEqual(r.lines.filter(l => l.line_type === '送料').map(l => [l.order_id, l.amount]), [['A01', 800]])
  assert.equal(r.invoice.subtotal_10, 9999 + 800 + 9999)
  assert.equal(r.invoice.subtotal_8, 1)
  assert.equal(r.invoice.tax_8, 0)
})

test('返品しても元の注文の送料は変わらず、返品は返品日の期間に計上する', () => {
  const orders = [order('A01', 'P04', 1, '確定', '2026-08-28')]
  const returns = [{ return_id: 'R1', return_date: '2026-09-02', order_id: 'A01', product_id: 'P04', quantity: '1' }]
  const r = invoiceFor('2026-09', customer, data({ orders, returns }))
  assert.deepEqual(r.lines.map(l => [l.line_type, l.quantity, l.amount]), [['返品', -1, -9999]])
  assert.deepEqual([r.invoice.order_count, r.invoice.return_count, r.invoice.subtotal_10, r.invoice.tax_10], [0, 1, -9999, -999])
})

test('繰越: 前回請求額（前月分）から期間内の入金を引く。注文がなくても、前回請求額か入金があれば発行する', () => {
  const balances = [{ customer_id: 'M1', month: '2026-08', amount: '5000' }, { customer_id: 'M1', month: '2026-07', amount: '9999' }]
  const payments = [
    { payment_id: 'K1', payment_date: '2026-09-30', customer_id: 'M1', amount: '1200' },
    { payment_id: 'K2', payment_date: '2026-08-31', customer_id: 'M1', amount: '700' },
  ]
  const r = invoiceFor('2026-09', customer, data({ balances, payments }))
  assert.deepEqual([r.invoice.previous_balance, r.invoice.payment, r.invoice.carried_over, r.invoice.total, r.invoice.total_due], [5000, 1200, 3800, 0, 3800])
})

test('取消の注文と期間外の注文は含めず、注文・返品・前回請求額・入金がどれもなければ発行しない', () => {
  assert.equal(invoiceFor('2026-09', customer, data({ orders: [order('Z1', 'P07', 1, '取消'), order('Z2', 'P07', 1, '確定', '2026-10-01')] })), null)
})

test('端数処理の空欄は切り捨て、税は請求書ごと税率ごとに1回', () => {
  const r = invoiceFor('2026-09', customer, data({ orders: [order('A12', 'P07', 3)] }))
  assert.deepEqual([r.invoice.subtotal_10, r.invoice.tax_10, r.invoice.total], [875, 87, 962])
})
