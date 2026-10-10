import assert from 'node:assert/strict'
import { test } from 'node:test'

import { approvalRoute, dailyAllowance, daysBetween, lodgingCap, paymentDate, reviewItem } from '../src/expense.js'

const item = (category, amount, over = {}) => ({ date: '2026-10-01', category, amount: String(amount), receipt: '有', count: '', kind: '', ...over })

test('期限: 60日ちょうどは期限内、61日は却下、提出日より後は却下', () => {
  assert.equal(daysBetween('2026-09-01', '2026-10-31'), 60)
  assert.equal(reviewItem(item('交通費', 500, { date: '2026-09-01' }), '一般', '2026-10-31').result, '承認')
  assert.equal(reviewItem(item('交通費', 500, { date: '2026-08-31' }), '一般', '2026-10-31').code, 'E01')
  assert.equal(reviewItem(item('交通費', 500, { date: '2026-11-01' }), '一般', '2026-10-31').code, 'E02')
})

test('領収書: 1,000円以上で必要、999円は不要、日当は不要', () => {
  assert.equal(reviewItem(item('交通費', 999, { receipt: '無' }), '一般', '2026-10-10').result, '承認')
  assert.equal(reviewItem(item('交通費', 1000, { receipt: '無' }), '一般', '2026-10-10').code, 'E03')
  assert.equal(reviewItem(item('日当', 2000, { receipt: '無', count: '1', kind: '宿泊' }), '一般', '2026-10-10').result, '承認')
})

test('宿泊費: 宿泊日で上限を選ぶ（10月1日から東京の一般・主任を引き上げ）、泊数を掛ける', () => {
  assert.equal(lodgingCap('一般', '東京', '2026-09-30'), 10000)
  assert.equal(lodgingCap('一般', '東京', '2026-10-01'), 12000)
  assert.equal(lodgingCap('主任', '東京', '2026-10-01'), 13000)
  assert.equal(lodgingCap('課長', '東京', '2026-10-01'), 12000)
  const r = reviewItem(item('宿泊費', 20000, { count: '2', kind: '大阪' }), '一般', '2026-10-10')
  assert.deepEqual([r.result, r.approved, r.code], ['一部承認', 18000, 'W01'])
})

test('日当: 役職の日額 × 日数、日帰りは半額。申請額が少なければ申請額', () => {
  assert.equal(dailyAllowance('主任', '日帰り', 3), 3750)
  assert.equal(dailyAllowance('課長', '宿泊', 3), 9000)
  assert.equal(reviewItem(item('日当', 1000, { count: '1', kind: '日帰り' }), '主任', '2026-10-10').approved, 1000)
  assert.equal(reviewItem(item('日当', 5000, { count: '3', kind: '日帰り' }), '主任', '2026-10-10').approved, 3750)
})

test('会議費: 1人 5,000円ちょうどは会議費、超えると接待費（W03）', () => {
  assert.equal(reviewItem(item('会議費', 15000, { count: '3' }), '一般', '2026-10-10').category, '会議費')
  const r = reviewItem(item('会議費', 15001, { count: '3' }), '一般', '2026-10-10')
  assert.deepEqual([r.category, r.code, r.approved], ['接待費', 'W03', 15001])
})

test('物品: 99,999円は承認、100,000円は却下', () => {
  assert.equal(reviewItem(item('物品', 99999), '一般', '2026-10-10').result, '承認')
  assert.equal(reviewItem(item('物品', 100000), '一般', '2026-10-10').code, 'E04')
})

const org = [
  { employee_id: 'X1', grade: '役員', manager_id: '' }, { employee_id: 'X2', grade: '部長', manager_id: 'X1' },
  { employee_id: 'X3', grade: '課長', manager_id: 'X2' }, { employee_id: 'X4', grade: '主任', manager_id: 'X3' },
  { employee_id: 'X5', grade: '一般', manager_id: 'X4' }, { employee_id: 'X6', grade: '部長', manager_id: 'X1' },
  { employee_id: 'X7', grade: '一般', manager_id: 'X6' },
]
const route = (id, amount, ent = false) => approvalRoute(org.find(e => e.employee_id === id), org, amount, ent).join('>')

test('承認経路: 上長、5万円以上か接待費で部長以上、30万円以上で役員、役員の申請は経理課長', () => {
  assert.equal(route('X5', 49999), 'X4')
  assert.equal(route('X5', 50000), 'X4>X2')
  assert.equal(route('X4', 3000, true), 'X3>X2')
  assert.equal(route('X3', 300000), 'X2>X1')
  assert.equal(route('X7', 300000), 'X6>X1')
  assert.equal(route('X2', 400000), 'X1')
  assert.equal(route('X1', 800), 'ACCT')
  assert.equal(route('X5', 0), '')
})

test('支払日: 翌月25日、土曜は24日、日曜は23日、12月分は翌年1月', () => {
  assert.equal(paymentDate('2026-10'), '2026-11-25')
  assert.equal(paymentDate('2027-03'), '2027-04-23')
  assert.equal(paymentDate('2027-08'), '2027-09-24')
  assert.equal(paymentDate('2026-12'), '2027-01-25')
})
