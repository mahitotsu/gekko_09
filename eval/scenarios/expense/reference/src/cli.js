#!/usr/bin/env node
// 経費精算の自動審査。連携仕様書 第4版 3章:
//   node src/cli.js --month YYYY-MM --data <入力ディレクトリ> --out <出力ディレクトリ>
// 終了コード: 0 成功、1 引数の誤り、2 入力データの不整合（何も出力しない）。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { readCsv, writeCsv } from './csv.js'
import { CATEGORIES, GRADES, paymentDate, reviewClaim } from './expense.js'

const CLAIM_COLS = ['claim_id', 'employee_id', 'submit_date', 'status', 'item_count', 'claimed_total', 'approved_total', 'route']
const ITEM_COLS = ['claim_id', 'item_no', 'date', 'category', 'claimed', 'approved', 'result', 'code']
const PAYMENT_COLS = ['employee_id', 'name', 'amount', 'payment_date']

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

const employees = readCsv(join(args.data, 'employees.csv'))
const claims = readCsv(join(args.data, 'claims.csv'))
const items = readCsv(join(args.data, 'items.csv'))

// 入力の検証（すべての行。対象月以外の申請も含む）。最初に見つかった不整合で止める。
const bad = message => fail(2, `入力の不整合: ${message}`)
const byId = new Map(employees.map(e => [e.employee_id, e]))
for (const e of employees) {
  if (!GRADES.includes(e.grade)) bad(`社員 ${e.employee_id} の役職 ${e.grade} は規程にありません`)
  if (e.grade === '役員' ? e.manager_id !== '' && !byId.has(e.manager_id) : !byId.has(e.manager_id))
    bad(`社員 ${e.employee_id} の上長 ${e.manager_id} が社員マスタにありません`)
}
const claimIds = new Set(claims.map(c => c.claim_id))
for (const c of claims) {
  if (!byId.has(c.employee_id)) bad(`申請 ${c.claim_id} の社員 ${c.employee_id} が社員マスタにありません`)
  if (!items.some(i => i.claim_id === c.claim_id)) bad(`申請 ${c.claim_id} に明細がありません`)
}
const KINDS = { 宿泊費: ['東京', '大阪', 'その他'], 日当: ['日帰り', '宿泊'] }
const COUNTED = ['宿泊費', '日当', '会議費', '接待費']
for (const i of items) {
  const where = `申請 ${i.claim_id} の明細 ${i.item_no}`
  if (!claimIds.has(i.claim_id)) bad(`${where}: 申請 ${i.claim_id} がありません`)
  if (!CATEGORIES.includes(i.category)) bad(`${where}: 区分 ${i.category} は規程にありません`)
  if (!/^\d+$/.test(i.amount)) bad(`${where}: 金額 ${i.amount} が正しくありません`)
  if (i.receipt !== '有' && i.receipt !== '無') bad(`${where}: 領収書の有無 ${i.receipt} が正しくありません`)
  if (COUNTED.includes(i.category) && !/^[1-9]\d*$/.test(i.count)) bad(`${where}: 数（泊数・日数・人数）${i.count} が正しくありません`)
  if (KINDS[i.category] && !KINDS[i.category].includes(i.kind)) bad(`${where}: 種別 ${i.kind} が正しくありません`)
}

const results = []
const itemResults = []
for (const c of claims.filter(c => c.submit_date.startsWith(args.month)).sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1))) {
  const r = reviewClaim(c, items.filter(i => i.claim_id === c.claim_id), byId.get(c.employee_id), employees)
  results.push(r.claim)
  itemResults.push(...r.items)
}
const totals = new Map()
for (const r of results) totals.set(r.employee_id, (totals.get(r.employee_id) ?? 0) + r.approved_total)
const payments = [...totals]
  .filter(([, amount]) => amount > 0)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([id, amount]) => ({ employee_id: id, name: byId.get(id).name, amount, payment_date: paymentDate(args.month) }))

mkdirSync(args.out, { recursive: true })
writeCsv(join(args.out, 'claim_results.csv'), CLAIM_COLS, results)
writeCsv(join(args.out, 'item_results.csv'), ITEM_COLS, itemResults)
writeCsv(join(args.out, 'payments.csv'), PAYMENT_COLS, payments)
