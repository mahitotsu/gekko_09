// 隠しテストのデータセットと期待値を作る（作業ディレクトリには持ち込まない）。
//   node eval/scenarios/attendance/hidden/make-datasets.mjs
// 期待値は reference/src/cli.js の出力。要所の手計算は reference/test にある。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '../reference/src/cli.js')
const out = join(here, 'datasets')

const csv = (cols, rows) => [cols.join(','), ...rows.map(r => r.join(','))].join('\n') + '\n'
const FILES = {
  employees: ['employee_id', 'name', 'hourly_rate', 'department'],
  punches: ['employee_id', 'date', 'in', 'out'],
  holidays: ['date', 'name'],
}

// 時給は、割増の1時間あたりの額が 0.5 円になる値を混ぜる（1234×25%=308.5、1006×25%=251.5、1010×35%=353.5、1001×50%=500.5）
const EMP = [
  ['A1', '甲野', 1200, '製造'], ['A2', '乙川', 1234, '製造'], ['A3', '丙田', 1006, '物流'], ['A4', '丁原', 1999, '物流'],
  ['A5', '戊島', 1010, '総務'], ['A6', '己屋', 1001, '総務'],
]
const p = (emp, date, inTime, outTime) => [emp, date, inTime, outTime]
const dayList = (emp, dates, inTime, outTime) => dates.map(d => p(emp, d, inTime, outTime))
const oct = days => days.map(d => `2026-10-${String(d).padStart(2, '0')}`)

const DATASETS = {
  // 丸め: 出勤は切り上げ（08:59→09:00、09:01→09:15）、退勤は切り捨て（17:14→17:00、17:16→17:15）。
  // 丸めた結果が逆転する打刻（09:01〜09:14）は実働 0 分で、行は出す
  round: {
    month: '2026-10',
    employees: EMP.slice(0, 1),
    punches: [
      p('A1', '2026-10-05', '08:59', '17:14'), p('A1', '2026-10-06', '09:00', '17:15'), p('A1', '2026-10-07', '09:01', '17:16'),
      p('A1', '2026-10-08', '08:46', '16:44'), p('A1', '2026-10-09', '09:01', '09:14'), p('A1', '2026-10-13', '09:00', '09:14'),
      p('A1', '2026-10-14', '08:00', '08:15'),
    ],
  },
  // 休憩: 拘束時間（丸めた後）が 6 時間ちょうどは 0、6 時間 15 分は 45 分、8 時間ちょうどは 45 分、8 時間 15 分は 60 分。
  // 丸める前は 6 時間を超える打刻（08:50〜15:10）でも、丸めると 6 時間ちょうどで休憩なし
  break: {
    month: '2026-10',
    employees: EMP.slice(0, 2),
    punches: [
      p('A1', '2026-10-05', '09:00', '15:00'), p('A1', '2026-10-06', '09:00', '15:15'), p('A1', '2026-10-07', '09:00', '17:00'),
      p('A1', '2026-10-08', '09:00', '17:15'), p('A1', '2026-10-09', '08:50', '15:10'), p('A1', '2026-10-13', '08:50', '17:10'),
      p('A2', '2026-10-05', '09:00', '16:59'), p('A2', '2026-10-06', '09:00', '17:00'), p('A2', '2026-10-07', '09:00', '09:15'),
    ],
  },
  // 深夜: 22:00〜翌 5:00（5:00 は含まない）、日またぎ、休憩（出勤の 4 時間後から）が深夜に重なる場合、早朝の勤務
  night: {
    month: '2026-10',
    employees: EMP.slice(0, 3),
    punches: [
      p('A1', '2026-10-05', '18:00', '23:00'), p('A1', '2026-10-06', '03:45', '12:00'), p('A1', '2026-10-07', '21:45', '23:45'),
      p('A1', '2026-10-08', '22:00', '05:00'), p('A1', '2026-10-09', '04:45', '05:15'),
      p('A2', '2026-10-05', '18:10', '03:20'), p('A2', '2026-10-06', '14:00', '22:00'), p('A2', '2026-10-07', '23:50', '00:20'),
      p('A2', '2026-10-08', '10:00', '23:00'), p('A2', '2026-10-13', '00:00', '23:59'),
      p('A3', '2026-10-05', '17:00', '06:00'), p('A3', '2026-10-06', '21:00', '08:00'),
    ],
  },
  // 日の種類: 土曜・会社休日（平日の 10/14、日曜と重なる 10/11）は所定休日・法定休日、日曜は法定休日（35% と深夜 25% を足す）。
  // 法定休日の労働は法定外にも週の累計にも入れない。所定休日の労働は 1 日 8 時間までが法定内
  holiday: {
    month: '2026-10',
    employees: EMP.slice(0, 3),
    holidays: [['2026-10-11', '振替の会社休日'], ['2026-10-14', '創立記念日']],
    punches: [
      p('A1', '2026-10-10', '09:00', '19:00'), p('A1', '2026-10-11', '09:00', '19:00'), p('A1', '2026-10-14', '09:00', '19:00'),
      p('A1', '2026-10-17', '09:00', '17:00'), p('A1', '2026-10-18', '20:00', '03:00'),
      p('A2', '2026-10-04', '22:00', '06:00'), p('A2', '2026-10-25', '08:00', '12:00'),
      p('A3', '2026-10-10', '08:00', '12:00'), p('A3', '2026-10-11', '08:00', '12:00'),
    ],
  },
  // 週 40 時間: 月曜〜日曜の週。前月（9/28〜9/30）の分を含めて数える、日の法定外は重ねて数えない、
  // 法定休日の労働は週に入れない、対象月より後の打刻は無視する
  week: {
    month: '2026-10',
    employees: EMP.slice(0, 4),
    punches: [
      ...dayList('A1', ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'], '08:00', '17:00'), p('A1', '2026-10-03', '09:00', '13:00'),
      p('A2', '2026-10-04', '09:00', '17:45'), ...dayList('A2', oct([5, 6, 7, 8, 9]), '09:00', '18:00'), p('A2', '2026-10-10', '09:00', '11:00'),
      ...dayList('A3', oct([26, 27, 28, 29, 30]), '08:00', '18:00'), p('A3', '2026-10-31', '08:00', '12:00'),
      p('A3', '2026-11-02', '08:00', '19:00'),
      ...dayList('A4', oct([19, 20, 21]), '08:00', '17:00'), p('A4', '2026-10-22', '08:00', '12:00'), p('A4', '2026-10-23', '08:00', '17:15'), p('A4', '2026-10-24', '08:00', '10:00'),
    ],
  },
  // 週が月をまたぐ（2026-12 は火曜はじまり）。11/30（月）の分を週の累計に含める（A1）。含めない場合と結果が変わる（A2 は 11/30 の打刻なし）。
  // 11/30 は対象月の外なので出力しない
  weekDec: {
    month: '2026-12',
    employees: EMP.slice(0, 2),
    punches: [
      ...dayList('A1', ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'], '08:00', '17:00'), p('A1', '2026-12-05', '08:00', '12:00'),
      ...dayList('A2', ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'], '08:00', '17:00'), p('A2', '2026-12-05', '08:00', '17:00'),
    ],
  },
  // 60 時間超: 累計がちょうど 3600 になる日は超過なし、次の日から超過。日の途中で超える場合は超えた分だけ。
  // 週の法定外も累計に入れる（A3）。法定休日の労働は入れない（A4）
  over60: {
    month: '2026-10',
    employees: EMP.slice(0, 4),
    punches: [
      ...dayList('A1', oct([1, 2, 5, 6, 7, 8, 9, 13, 14, 15, 16, 19, 20]), '08:30', '22:30'),
      ...dayList('A2', oct([1, 2, 5, 6, 7, 8, 9, 13, 14, 15, 16]), '08:30', '22:30'), p('A2', '2026-10-19', '08:30', '23:30'), p('A2', '2026-10-20', '08:30', '22:30'),
      ...dayList('A3', oct([5, 6, 7, 8, 9]), '08:00', '17:00'), ...dayList('A3', oct([12, 13, 14, 15, 16]), '08:00', '23:00'), p('A3', '2026-10-17', '08:00', '16:00'),
      ...dayList('A3', oct([19, 20, 21, 22, 23]), '08:00', '23:00'), p('A3', '2026-10-24', '08:00', '16:00'),
      ...dayList('A4', oct([4, 11, 18, 25]), '07:00', '23:00'), ...dayList('A4', oct([5, 6, 7, 8, 9, 12, 13, 14, 15, 16]), '08:30', '22:30'), p('A4', '2026-10-19', '08:30', '22:30'),
    ],
  },
  // 60 時間の累計は月ごと: 9 月に 60 時間を超えても、10 月の累計は 0 から数える
  over60Reset: {
    month: '2026-10',
    employees: EMP.slice(0, 1),
    punches: [
      ...dayList('A1', ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'], '08:30', '23:30'),
      ...dayList('A1', ['2026-10-01', '2026-10-02'], '08:30', '23:30'), p('A1', '2026-10-05', '08:30', '22:30'),
    ],
  },
  // 60 時間超は 2026-10 分から: 同じ入力でも 9 月分は 25% のまま（over60_min は 0）
  over60Sep: {
    month: '2026-09',
    employees: EMP.slice(0, 1),
    punches: [
      ...dayList('A1', ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'], '08:30', '22:30'),
      p('A1', '2026-10-01', '08:30', '22:30'),
    ],
  },
  // 残業の注意: 2700 分ちょうどは出さない、2715 分は 45H超、4800 分ちょうどは 45H超、4815 分は 80H超
  alerts: {
    month: '2026-10',
    employees: EMP.slice(0, 5),
    punches: [
      ...dayList('A1', oct([1, 2, 5, 6, 7, 8, 9, 13, 14]), '08:30', '22:30'),
      ...dayList('A2', oct([1, 2, 5, 6, 7, 8, 9, 13, 14]), '08:30', '22:30'), p('A2', '2026-10-15', '09:00', '18:15'),
      ...dayList('A3', oct([1, 2, 5, 6, 7, 8, 9, 13, 14, 15, 16, 19, 20, 21, 22, 23]), '08:30', '22:30'),
      ...dayList('A4', oct([1, 2, 5, 6, 7, 8, 9, 13, 14, 15, 16, 19, 20, 21, 22, 23]), '08:30', '22:30'), p('A4', '2026-10-26', '09:00', '18:15'),
      p('A5', '2026-10-05', '09:00', '17:00'),
    ],
  },
  // 割増の 1 時間あたりの額の四捨五入と、月の合計に対する切り捨て（日ごとに切り捨てた合計とは一致しない）
  rounding: {
    month: '2026-10',
    employees: EMP,
    punches: [
      ...EMP.flatMap(([id]) => [p(id, '2026-10-05', '08:45', '19:30'), p(id, '2026-10-06', '08:45', '19:45'), p(id, '2026-10-07', '20:00', '23:45'), p(id, '2026-10-11', '09:15', '12:30')]),
    ],
  },
  // 打刻のない社員と、対象月の外の打刻だけの社員は、月ごとの結果に出さない。対象月に打刻がなければ見出しだけ
  empty: {
    month: '2026-10',
    employees: EMP.slice(0, 3),
    punches: [p('A1', '2026-10-05', '09:00', '18:00'), p('A2', '2026-09-30', '09:00', '20:00'), p('A2', '2026-11-02', '09:00', '20:00')],
  },
  emptyMonth: {
    month: '2026-12',
    employees: EMP.slice(0, 2),
    punches: [p('A1', '2026-10-05', '09:00', '18:00')],
  },
}

// 乱数で作る大きめのデータ（シード固定）
const rand = (seed => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648))(20261011)
const pick = xs => xs[Math.floor(rand() * xs.length)]
const randEmployees = Array.from({ length: 14 }, (_, i) => [`Z${String(i + 1).padStart(2, '0')}`, `乱数${i + 1}`, 900 + Math.floor(rand() * 1500), pick(['製造', '物流', '総務'])])
const date = (base, offset) => new Date(Date.parse(base) + offset * 86400000).toISOString().slice(0, 10)
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const randPunches = []
for (const [id] of randEmployees) {
  const heavy = ['Z01', 'Z02', 'Z03'].includes(id) // 残業の多い社員（注意の一覧が空にならないように）
  for (let off = 0; off < 80; off++) {
    if (rand() < 0.3) continue
    const d = date('2026-08-24', off)
    const night = rand() < 0.12
    const start = night ? 16 * 60 + Math.floor(rand() * 8 * 60) : 6 * 60 + Math.floor(rand() * 5 * 60)
    const len = night ? 5 * 60 + Math.floor(rand() * 8 * 60) : heavy ? 9 * 60 + Math.floor(rand() * 6 * 60) : 60 + Math.floor(rand() * (rand() < 0.3 ? 16 : 11) * 60)
    randPunches.push(p(id, d, hhmm(start), hhmm(start + len)))
  }
}
const randHolidays = [['2026-09-21', '敬老の日'], ['2026-09-22', '国民の休日'], ['2026-10-12', 'スポーツの日'], ['2026-10-23', '創立記念日'], ['2026-11-03', '文化の日']]
DATASETS.random = { month: '2026-10', employees: randEmployees, holidays: randHolidays, punches: randPunches }
DATASETS.randomSep = { month: '2026-09', employees: randEmployees, holidays: randHolidays, punches: randPunches }
DATASETS.randomNov = { month: '2026-11', employees: randEmployees, holidays: randHolidays, punches: randPunches }

rmSync(out, { recursive: true, force: true })
const write = (dir, d) => {
  mkdirSync(dir, { recursive: true })
  for (const [name, cols] of Object.entries(FILES)) writeFileSync(join(dir, `${name}.csv`), csv(cols, d[name] ?? (name === 'employees' ? EMP : [])))
}
for (const [name, d] of Object.entries(DATASETS)) {
  const dir = join(out, name)
  write(join(dir, 'input'), d)
  writeFileSync(join(dir, 'month'), d.month + '\n')
  execFileSync('node', [cli, '--month', d.month, '--data', join(dir, 'input'), '--out', join(dir, 'expected')])
}

// 入力の不整合（終了コード 2）。それぞれ、問題の行を示す番号がメッセージに出ること。
const okPunch = p('A1', '2026-10-05', '09:00', '18:00')
const BAD = {
  badRate: [{ employees: [...EMP, ['A9', '時給誤り', '12.5', '総務']], punches: [okPunch] }, 'A9'],
  zeroRate: [{ employees: [...EMP, ['A9', '時給零', '0', '総務']], punches: [okPunch] }, 'A9'],
  dupEmployee: [{ employees: [...EMP, ['A2', '重複', 1000, '総務']], punches: [okPunch] }, 'A2'],
  badPunchEmployee: [{ punches: [okPunch, p('A8', '2026-10-06', '09:00', '18:00')] }, 'A8'],
  badPunchDate: [{ punches: [okPunch, p('A2', '2026-02-30', '09:00', '18:00')] }, 'A2'],
  badTime: [{ punches: [okPunch, p('A3', '2026-10-06', '25:00', '18:00')] }, 'A3'],
  badTimeShort: [{ punches: [okPunch, p('A3', '2026-10-06', '9:00', '18:00')] }, 'A3'],
  sameTime: [{ punches: [okPunch, p('A4', '2026-10-06', '09:00', '09:00')] }, 'A4'],
  dupPunch: [{ punches: [okPunch, p('A5', '2026-10-06', '09:00', '18:00'), p('A5', '2026-10-06', '10:00', '19:00')] }, 'A5'],
  badOutsideMonth: [{ punches: [okPunch, p('A6', '2026-08-06', '09:00', '99:00')] }, 'A6'],
  badHoliday: [{ holidays: [['2026-13-01', '誤り']], punches: [okPunch] }, '2026-13-01'],
}
for (const [name, [d, id]] of Object.entries(BAD)) {
  write(join(out, name, 'input'), d)
  writeFileSync(join(out, name, 'error-id'), id + '\n')
}
console.log(`datasets -> ${out}`)
