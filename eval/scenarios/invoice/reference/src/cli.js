#!/usr/bin/env node
// 請求書の作成。連携仕様書 第4版 3章:
//   node src/cli.js --month YYYY-MM --data <入力ディレクトリ> --out <出力ディレクトリ>
// 終了コード: 0 成功、1 引数の誤り、2 入力データの不整合（何も出力しない）。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { invoiceFor, priceRowAt } from './billing.js'
import { readCsv, writeCsv } from './csv.js'

const INVOICE_COLS = ['invoice_no', 'customer_id', 'customer_name', 'period_start', 'period_end', 'previous_balance',
  'payment', 'carried_over', 'order_count', 'return_count', 'subtotal_10', 'tax_10', 'subtotal_8', 'tax_8', 'total',
  'total_due']
const LINE_COLS = ['invoice_no', 'line_type', 'order_id', 'date', 'product_id', 'product_name', 'quantity',
  'unit_price', 'amount', 'tax_rate']

function fail(code, message) {
  process.stderr.write(message + '\n')
  process.exit(code)
}

let args
try {
  args = parseArgs({ options: { month: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' } } }).values
} catch (err) {
  fail(1, `引数の誤り: ${err.message}`)
}
if (!args.month || !args.data || !args.out) fail(1, '引数の誤り: --month、--data、--out はすべて必要です')
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) fail(1, `引数の誤り: --month は YYYY-MM の形式で指定してください: ${args.month}`)

const read = name => readCsv(join(args.data, name))
const customers = read('customers.csv')
const products = new Map()
for (const p of read('products.csv')) {
  if (!products.has(p.product_id)) products.set(p.product_id, [])
  products.get(p.product_id).push(p)
}
const orders = read('orders.csv')
const returns = read('returns.csv')
const payments = read('payments.csv')
const balances = read('balances.csv')

// 入力の検証（すべての行。対象期間外や取消の注文も含む）。最初に見つかった不整合で止める。
const customerIds = new Set(customers.map(c => c.customer_id))
const bad = message => fail(2, `入力の不整合: ${message}`)
for (const o of orders) {
  if (!customerIds.has(o.customer_id)) bad(`注文 ${o.order_id} の顧客 ${o.customer_id} が顧客マスタにありません`)
  if (!products.has(o.product_id)) bad(`注文 ${o.order_id} の商品 ${o.product_id} が商品マスタにありません`)
  if (!priceRowAt(products.get(o.product_id), o.order_date))
    bad(`注文 ${o.order_id} の商品 ${o.product_id} に、注文日 ${o.order_date} の時点で有効な価格がありません`)
}
const returned = new Map() // 注文番号/商品コード → 返品数量の合計
for (const r of returns) {
  const line = orders.find(o => o.order_id === r.order_id && o.product_id === r.product_id)
  if (!orders.some(o => o.order_id === r.order_id)) bad(`返品 ${r.return_id} の注文 ${r.order_id} がありません`)
  if (!line) bad(`返品 ${r.return_id} の商品 ${r.product_id} は注文 ${r.order_id} に含まれていません`)
  if (line.status !== '確定') bad(`返品 ${r.return_id} の注文 ${r.order_id} は取消されています`)
  const key = `${r.order_id}/${r.product_id}`
  const total = (returned.get(key) ?? 0) + Number(r.quantity)
  if (total > Number(line.quantity)) bad(`返品 ${r.return_id} で、注文 ${r.order_id} の商品 ${r.product_id} の返品数量が注文数量を超えます`)
  returned.set(key, total)
}
for (const p of payments)
  if (!customerIds.has(p.customer_id)) bad(`入金 ${p.payment_id} の顧客 ${p.customer_id} が顧客マスタにありません`)
for (const b of balances)
  if (!customerIds.has(b.customer_id)) bad(`前回請求額の顧客 ${b.customer_id} が顧客マスタにありません`)

const data = { orders, products, returns, payments, balances }
const invoices = []
const lines = []
for (const c of [...customers].sort((a, b) => (a.customer_id < b.customer_id ? -1 : 1))) {
  const r = invoiceFor(args.month, c, data)
  if (!r) continue
  invoices.push(r.invoice)
  lines.push(...r.lines)
}
mkdirSync(args.out, { recursive: true })
writeCsv(join(args.out, 'invoices.csv'), INVOICE_COLS, invoices)
writeCsv(join(args.out, 'invoice_lines.csv'), LINE_COLS, lines)
