import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { alertLevel, analyze, breakMinutes, dayType, measure, monthly, pay, premiumUnit, weekOf } from '../src/attendance.js'

const NONE = new Set()

test('丸め: 出勤は切り上げ、退勤は切り捨て。逆転したら実働 0', () => {
  assert.deepEqual([measure('08:59', '17:14').start, measure('08:59', '17:14').end], [540, 1020])
  assert.deepEqual([measure('09:01', '17:16').start, measure('09:01', '17:16').end], [555, 1035])
  assert.equal(measure('09:01', '09:14').work, 0)
})

test('休憩: 拘束時間 6 時間ちょうどは 0、6 時間 15 分は 45、8 時間ちょうどは 45、8 時間 15 分は 60', () => {
  assert.deepEqual([360, 375, 480, 495].map(breakMinutes), [0, 45, 45, 60])
  assert.equal(measure('08:50', '15:10').brk, 0) // 丸めると 09:00〜15:00
})

test('深夜: 22:00〜翌 5:00、5:00 は含まない、休憩は出勤の 4 時間後から引く', () => {
  assert.equal(measure('22:00', '05:00').night, 375) // 420 分 − 休憩 45（01:00〜01:45）
  assert.equal(measure('04:45', '05:15').night, 15)
  assert.equal(measure('14:00', '22:00').night, 0)
  assert.equal(measure('18:10', '03:20').night, 255) // 18:15〜03:15、休憩 22:15〜23:15 は深夜
  assert.equal(measure('23:50', '00:20').work, 15) // 00:00〜00:15
})

test('日の種類: 日曜は法定休日、土曜と会社休日は所定休日、日曜と会社休日が重なれば法定休日', () => {
  assert.equal(dayType('2026-10-04', NONE), '法定休日')
  assert.equal(dayType('2026-10-03', NONE), '所定休日')
  assert.equal(dayType('2026-10-14', new Set(['2026-10-14'])), '所定休日')
  assert.equal(dayType('2026-10-11', new Set(['2026-10-11'])), '法定休日')
  assert.equal(dayType('2026-10-14', NONE), '平日')
})

test('週: 月曜はじまり', () => {
  assert.equal(weekOf('2026-10-04'), weekOf('2026-09-28'))
  assert.notEqual(weekOf('2026-10-05'), weekOf('2026-10-04'))
})

const day = (date, inTime, outTime) => ({ employee_id: 'A', date, in: inTime, out: outTime })

test('法定外: 1日 8 時間超と、週 40 時間超（前月の日を含む、日の分は重ねない）', () => {
  const rows = analyze(
    [...['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map(d => day(d, '08:00', '17:00')), day('2026-10-03', '09:00', '13:00')],
    NONE,
  )
  assert.deepEqual(rows.map(r => r.overtime_min), [0, 0, 0, 0, 0, 240])
  const daily = analyze([day('2026-10-26', '08:00', '18:00')], NONE)
  assert.equal(daily[0].overtime_min, 60)
})

test('法定休日の労働は法定外・週の累計に入れず、全体が holiday_min', () => {
  const rows = analyze([day('2026-10-04', '09:00', '19:00'), ...['05', '06', '07', '08', '09'].map(d => day(`2026-10-${d}`, '08:00', '17:00'))], NONE)
  assert.deepEqual([rows[0].overtime_min, rows[0].holiday_min, rows[0].work_min], [0, 540, 540])
  assert.equal(rows[5].overtime_min, 0)
})

test('60 時間超: 累計 3600 ちょうどは超過なし、次の日から超過。2026-10 より前の月は 0。月ごとに累計をやり直す', () => {
  const dates = ['01', '02', '05', '06', '07', '08', '09', '13', '14', '15', '16', '19', '20']
  const rows = analyze(dates.map(d => day(`2026-10-${d}`, '08:30', '22:30')), NONE)
  assert.deepEqual([rows[11].over60_min, rows[12].over60_min], [0, 300])
  const sep = analyze(['01', '02', '03', '04', '07', '08', '09', '10', '11', '14', '15', '16', '17'].map(d => day(`2026-09-${d}`, '08:30', '22:30')), NONE)
  assert.ok(sep.every(r => r.over60_min === 0))
  const mixed = analyze([...['28', '29', '30'].map(d => day(`2026-09-${d}`, '08:30', '23:30')), day('2026-10-01', '08:30', '23:30')], NONE)
  assert.equal(mixed[3].over60_min, 0)
})

test('割増の額: 1時間あたりの額は四捨五入、金額は月の合計の分に対して切り捨て', () => {
  assert.equal(premiumUnit(1234, 25), 309) // 308.5
  assert.equal(premiumUnit(1010, 35), 354) // 353.5
  assert.equal(premiumUnit(1001, 50), 501) // 500.5
  assert.equal(premiumUnit(1001, 25), 250) // 250.25
  assert.equal(pay(309, 630), 3244) // 3244.5
  const m = monthly({ employee_id: 'A', name: 'a', hourly_rate: '1234' }, [
    { work_min: 1440, overtime_min: 0, over60_min: 0, night_min: 630, holiday_min: 345 },
  ])
  assert.deepEqual([m.base_pay, m.night_pay, m.holiday_pay, m.total_pay], [29616, 3244, 2484, 35344])
})

test('注意の一覧: 2700 ちょうどは出さない、4800 ちょうどは 45H超', () => {
  assert.deepEqual([2700, 2715, 4800, 4815].map(alertLevel), ['', '45H超', '45H超', '80H超'])
})

const here = new URL('..', import.meta.url).pathname
// 作業ディレクトリでは docs/資料/data、シナリオのリポジトリでは materials/data
const sample = [join(here, 'docs/資料/data'), join(here, '../materials/data')].find(existsSync)
const run = (...args) => spawnSync('node', [join(here, 'src/cli.js'), ...args], { encoding: 'utf8' })

test('CLI: サンプルデータの結果が連携仕様書の例と一致し、月ごとの結果と注意の一覧を出す', () => {
  const out = mkdtempSync(join(tmpdir(), 'att-'))
  const r = run('--month', '2026-10', '--data', sample, '--out', out)
  assert.equal(r.status, 0, r.stderr)
  const lines = readFileSync(join(out, 'monthly_results.csv'), 'utf8').trim().split('\n')
  assert.equal(lines[2], 'E102,青木 凛,1440,0,0,630,345,1234,29616,0,0,3244,2484,35344')
  assert.equal(lines[4], 'E104,高田 美咲,11790,4635,1035,420,435,1850,363525,27780,15956,3241,4698,415200')
  assert.equal(readFileSync(join(out, 'alerts.csv'), 'utf8'), 'employee_id,name,overtime_min,level\nE104,高田 美咲,4635,45H超\n')
})

test('CLI: 引数の誤りは終了コード 1、入力データの不整合は終了コード 2 で何も出さない', () => {
  assert.equal(run('--month', '2026-13', '--data', 'x', '--out', 'y').status, 1)
  const dir = mkdtempSync(join(tmpdir(), 'att-'))
  writeFileSync(join(dir, 'employees.csv'), 'employee_id,name,hourly_rate,department\nA1,甲,1000,製造\n')
  writeFileSync(join(dir, 'holidays.csv'), 'date,name\n')
  writeFileSync(join(dir, 'punches.csv'), 'employee_id,date,in,out\nA1,2026-10-05,09:00,09:00\n')
  const out = join(dir, 'out')
  const r = run('--month', '2026-10', '--data', dir, '--out', out)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /A1/)
  assert.ok(!existsSync(join(out, 'monthly_results.csv')))
})
