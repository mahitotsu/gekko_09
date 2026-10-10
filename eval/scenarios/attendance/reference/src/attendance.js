// 勤怠集計と残業代の計算。就業規程（2026-10-01 改定）と、議事録の決定（第2回〜第4回）に従う。

export const ROUND_UNIT = 15 // 出勤は切り上げ、退勤は切り捨て（分）
export const BREAK_AFTER = 240 // 休憩は、丸めた出勤の 240 分後から取ったものとして扱う
export const LEGAL_DAY = 480 // 1日 8 時間
export const LEGAL_WEEK = 2400 // 週 40 時間
export const OVER60_FROM = 3600 // 月 60 時間
export const OVER60_START_MONTH = '2026-10' // 60 時間超の 50% はこの月分から
export const ALERT_45 = 2700 // 法定外が 45 時間を超えたら注意
export const ALERT_80 = 4800 // 80 時間を超えたら重大
// 割増率（%）。割増の部分だけ。
export const RATE = { overtime: 25, over60: 50, night: 25, holiday: 35 }

const dayNo = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000
export const weekday = d => new Date(dayNo(d) * 86400000).getUTCDay() // 0 日曜
// 月曜はじまりの週の番号（同じ週なら同じ値）
export const weekOf = d => Math.floor((dayNo(d) + 3) / 7)

export const toMinutes = t => +t.slice(0, 2) * 60 + +t.slice(3, 5)
export const toClock = m => {
  const x = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
}

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return new Date(dayNo(s) * 86400000).toISOString().slice(0, 10) === s
}
export const isValidTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)

// 日の種類: 日曜は法定休日、土曜と会社休日は所定休日、ほかは平日。
export function dayType(date, holidays) {
  const wd = weekday(date)
  if (wd === 0) return '法定休日'
  if (wd === 6 || holidays.has(date)) return '所定休日'
  return '平日'
}

// 休憩（分）。丸めたあとの拘束時間で決める。6 時間ちょうどは 0、8 時間ちょうどは 45。
export const breakMinutes = span => (span > 480 ? 60 : span > 360 ? 45 : 0)

// 1 日分の打刻（出勤・退勤の "HH:MM"）を丸めて、実働と深夜の分を求める。
// 退勤が出勤より前の時刻なら、翌日の退勤。実働は日付の出勤日に数える。
export function measure(inTime, outTime) {
  const rawIn = toMinutes(inTime)
  const rawOut = toMinutes(outTime) + (toMinutes(outTime) < rawIn ? 1440 : 0)
  const start = Math.ceil(rawIn / ROUND_UNIT) * ROUND_UNIT
  const end = Math.floor(rawOut / ROUND_UNIT) * ROUND_UNIT
  const span = Math.max(0, end - start)
  const brk = breakMinutes(span)
  let work = 0
  let night = 0
  for (let m = start; m < end; m++) {
    if (m >= start + BREAK_AFTER && m < start + BREAK_AFTER + brk) continue
    work++
    const t = m % 1440
    if (t < 300 || t >= 1320) night++
  }
  return { start, end, brk, work, night }
}

// 1 人分の全打刻を日付順に処理して、日ごとの結果を返す。
// 週（月曜はじまり）の累計は月をまたぐ。60 時間の累計は月ごと。
export function analyze(punches, holidays) {
  const rows = []
  let week = -1
  let weekInner = 0
  let month = ''
  let monthExtra = 0
  for (const p of punches.slice().sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (weekOf(p.date) !== week) [week, weekInner] = [weekOf(p.date), 0]
    if (p.date.slice(0, 7) !== month) [month, monthExtra] = [p.date.slice(0, 7), 0]
    const type = dayType(p.date, holidays)
    const m = measure(p.in, p.out)
    let overtime = 0
    let over60 = 0
    let holiday = 0
    if (type === '法定休日') {
      holiday = m.work
    } else {
      const inner = Math.min(m.work, LEGAL_DAY)
      const weekExtra = Math.min(Math.max(0, weekInner + inner - LEGAL_WEEK), inner)
      weekInner += inner
      overtime = m.work - inner + weekExtra
      if (month >= OVER60_START_MONTH) over60 = Math.min(Math.max(0, monthExtra + overtime - OVER60_FROM), overtime)
      monthExtra += overtime
    }
    rows.push({
      employee_id: p.employee_id, date: p.date, day_type: type, clock_in: toClock(m.start), clock_out: toClock(m.end),
      break_min: m.brk, work_min: m.work, overtime_min: overtime, over60_min: over60, night_min: m.night, holiday_min: holiday,
    })
  }
  return rows
}

// 割増の 1 時間あたりの額: 時給 × 率 を円未満で四捨五入（0.5 は切り上げ）。
export const premiumUnit = (rate, pct) => Math.floor((rate * pct + 50) / 100)
// 金額: 1 時間あたりの額 × 分 ÷ 60 を円未満切り捨て（月の合計の分に対して 1 回）。
export const pay = (unit, minutes) => Math.floor((unit * minutes) / 60)

export function monthly(employee, days) {
  const sum = k => days.reduce((s, d) => s + d[k], 0)
  const rate = Number(employee.hourly_rate)
  const work = sum('work_min')
  const overtime = sum('overtime_min')
  const over60 = sum('over60_min')
  const night = sum('night_min')
  const holiday = sum('holiday_min')
  const row = {
    employee_id: employee.employee_id, name: employee.name, work_min: work, overtime_min: overtime, over60_min: over60,
    night_min: night, holiday_min: holiday, hourly_rate: rate,
    base_pay: pay(rate, work),
    overtime_pay: pay(premiumUnit(rate, RATE.overtime), overtime - over60),
    over60_pay: pay(premiumUnit(rate, RATE.over60), over60),
    night_pay: pay(premiumUnit(rate, RATE.night), night),
    holiday_pay: pay(premiumUnit(rate, RATE.holiday), holiday),
  }
  row.total_pay = row.base_pay + row.overtime_pay + row.over60_pay + row.night_pay + row.holiday_pay
  return row
}

export const alertLevel = overtime => (overtime > ALERT_80 ? '80H超' : overtime > ALERT_45 ? '45H超' : '')
