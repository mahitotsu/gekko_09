#!/usr/bin/env node
// 勤怠集計。連携仕様書 第4版 3章:
//   node src/cli.js --month YYYY-MM --data <入力ディレクトリ> --out <出力ディレクトリ>
// 終了コード: 0 成功、1 引数の誤り、2 入力データの不整合（何も出力しない）。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { alertLevel, analyze, isValidDate, isValidTime, monthly } from './attendance.js'
import { readCsv, writeCsv } from './csv.js'

const DAY_COLS = ['employee_id', 'date', 'day_type', 'clock_in', 'clock_out', 'break_min', 'work_min', 'overtime_min', 'over60_min', 'night_min', 'holiday_min']
const MONTH_COLS = ['employee_id', 'name', 'work_min', 'overtime_min', 'over60_min', 'night_min', 'holiday_min', 'hourly_rate', 'base_pay', 'overtime_pay', 'over60_pay', 'night_pay', 'holiday_pay', 'total_pay']
const ALERT_COLS = ['employee_id', 'name', 'overtime_min', 'level']

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
const punches = readCsv(join(args.data, 'punches.csv'))
const holidayRows = readCsv(join(args.data, 'holidays.csv'))

// 入力の検証（すべての行。対象月以外も含む）。最初に見つかった不整合で止める。
const bad = message => fail(2, `入力の不整合: ${message}`)
const ids = new Set()
for (const e of employees) {
  if (ids.has(e.employee_id)) bad(`社員 ${e.employee_id} が重複しています`)
  ids.add(e.employee_id)
  if (!/^[1-9]\d*$/.test(e.hourly_rate)) bad(`社員 ${e.employee_id} の時給 ${e.hourly_rate} が正しくありません`)
}
for (const h of holidayRows) if (!isValidDate(h.date)) bad(`会社休日 ${h.date} の日付が正しくありません`)
const seen = new Set()
for (const p of punches) {
  const where = `社員 ${p.employee_id} の ${p.date}`
  if (!ids.has(p.employee_id)) bad(`${where}: 社員が社員マスタにありません`)
  if (!isValidDate(p.date)) bad(`${where}: 日付が正しくありません`)
  if (!isValidTime(p.in) || !isValidTime(p.out)) bad(`${where}: 時刻 ${p.in}、${p.out} が正しくありません`)
  if (p.in === p.out) bad(`${where}: 出勤と退勤が同じ時刻です`)
  if (seen.has(`${p.employee_id} ${p.date}`)) bad(`${where}: 打刻が重複しています`)
  seen.add(`${p.employee_id} ${p.date}`)
}

const holidays = new Set(holidayRows.map(h => h.date))
const days = []
const months = []
const alerts = []
for (const e of employees.slice().sort((a, b) => (a.employee_id < b.employee_id ? -1 : 1))) {
  const mine = analyze(punches.filter(p => p.employee_id === e.employee_id), holidays).filter(d => d.date.startsWith(args.month))
  if (mine.length === 0) continue
  days.push(...mine)
  const m = monthly(e, mine)
  months.push(m)
  const level = alertLevel(m.overtime_min)
  if (level) alerts.push({ employee_id: e.employee_id, name: e.name, overtime_min: m.overtime_min, level })
}

mkdirSync(args.out, { recursive: true })
writeCsv(join(args.out, 'daily_results.csv'), DAY_COLS, days)
writeCsv(join(args.out, 'monthly_results.csv'), MONTH_COLS, months)
writeCsv(join(args.out, 'alerts.csv'), ALERT_COLS, alerts)
