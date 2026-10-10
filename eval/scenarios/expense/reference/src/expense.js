// 経費精算の審査。経費精算規程（2026-10-01 改定）と、議事録の決定（第2回〜第4回）に従う。

export const GRADES = ['一般', '主任', '課長', '部長', '役員']
export const CATEGORIES = ['交通費', '宿泊費', '日当', '会議費', '接待費', '物品']

// 宿泊費の1泊あたりの上限（宿泊日で版を選ぶ）。2026-10-01 から東京の一般・主任を引き上げ。
const LODGING_BASE = {
  一般: { 東京: 10000, 大阪: 9000, その他: 8000 },
  主任: { 東京: 11000, 大阪: 10000, その他: 9000 },
  課長: { 東京: 12000, 大阪: 11000, その他: 10000 },
  部長: { 東京: 14000, 大阪: 13000, その他: 12000 },
  役員: { 東京: 18000, 大阪: 16000, その他: 15000 },
}
const LODGING_FROM_2026_10 = { 一般: { 東京: 12000 }, 主任: { 東京: 13000 } }
export const LODGING_REVISION = '2026-10-01'

export const DAILY_ALLOWANCE = { 一般: 2000, 主任: 2500, 課長: 3000, 部長: 4000, 役員: 5000 }
export const DEADLINE_DAYS = 60 // 提出日から数えて 60 日より前の経費は期限切れ
export const RECEIPT_FROM = 1000 // この金額以上は領収書が必要（日当を除く）
export const ASSET_FROM = 100000 // 物品はこの金額以上なら精算できない
export const MEETING_PER_PERSON = 5000 // 会議費は1人あたりこの金額を超えると接待費
export const DEPT_APPROVAL_FROM = 50000 // この金額以上は部長の承認も必要
export const EXEC_APPROVAL_FROM = 300000 // この金額以上は役員の承認も必要
export const ACCOUNTING = 'ACCT' // 役員の申請を承認する経理課長

const day = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000
export const daysBetween = (from, to) => day(to) - day(from)

export function lodgingCap(grade, place, date) {
  const revised = date >= LODGING_REVISION ? LODGING_FROM_2026_10[grade]?.[place] : undefined
  return revised ?? LODGING_BASE[grade][place]
}

export function dailyAllowance(grade, kind, days) {
  const perDay = kind === '日帰り' ? DAILY_ALLOWANCE[grade] / 2 : DAILY_ALLOWANCE[grade]
  return perDay * days
}

// 1 明細の審査。結果: 承認・一部承認・却下。コード: E01〜E04（却下）、W01〜W03（注記）。
export function reviewItem(item, grade, submitDate) {
  const amount = Number(item.amount)
  const count = Number(item.count)
  const res = (result, approved, code = '', category = item.category) => ({ result, approved, code, category })
  if (item.date > submitDate) return res('却下', 0, 'E02')
  if (daysBetween(item.date, submitDate) > DEADLINE_DAYS) return res('却下', 0, 'E01')
  if (item.category !== '日当' && item.receipt === '無' && amount >= RECEIPT_FROM) return res('却下', 0, 'E03')
  if (item.category === '物品' && amount >= ASSET_FROM) return res('却下', 0, 'E04')
  if (item.category === '宿泊費') {
    const cap = lodgingCap(grade, item.kind, item.date) * count
    return amount > cap ? res('一部承認', cap, 'W01') : res('承認', amount)
  }
  if (item.category === '日当') {
    const cap = dailyAllowance(grade, item.kind, count)
    return amount > cap ? res('一部承認', cap, 'W02') : res('承認', amount)
  }
  if (item.category === '会議費' && amount > MEETING_PER_PERSON * count) return res('承認', amount, 'W03', '接待費')
  return res('承認', amount)
}

// 承認経路: 上長、必要なら部長（部長以上）、必要なら役員。役員の申請は経理課長。
export function approvalRoute(employee, employees, approvedTotal, hasEntertainment) {
  if (approvedTotal === 0) return []
  if (employee.grade === '役員') return [ACCOUNTING]
  const byId = new Map(employees.map(e => [e.employee_id, e]))
  const rank = e => GRADES.indexOf(e.grade)
  const route = [byId.get(employee.manager_id)]
  const climb = (from, minGrade) => {
    for (let e = from; e; e = byId.get(e.manager_id)) if (rank(e) >= GRADES.indexOf(minGrade)) return e
    return undefined
  }
  if ((approvedTotal >= DEPT_APPROVAL_FROM || hasEntertainment) && rank(route.at(-1)) < GRADES.indexOf('部長'))
    route.push(climb(route.at(-1), '部長'))
  if (approvedTotal >= EXEC_APPROVAL_FROM && !route.some(e => e.grade === '役員')) route.push(climb(route.at(-1), '役員'))
  return route.map(e => e.employee_id)
}

// 支払日: 対象月の翌月25日。土曜・日曜なら直前の金曜日。
export function paymentDate(month) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 25))
  const wd = d.getUTCDay()
  if (wd === 6) d.setUTCDate(24)
  if (wd === 0) d.setUTCDate(23)
  return d.toISOString().slice(0, 10)
}

// 1 申請の審査。
export function reviewClaim(claim, items, employee, employees) {
  const reviewed = items
    .slice()
    .sort((a, b) => Number(a.item_no) - Number(b.item_no))
    .map(it => ({ item: it, ...reviewItem(it, employee.grade, claim.submit_date) }))
  const claimed = reviewed.reduce((s, r) => s + Number(r.item.amount), 0)
  const approved = reviewed.reduce((s, r) => s + r.approved, 0)
  const status = reviewed.every(r => r.result === '却下') ? '却下' : reviewed.some(r => r.result !== '承認') ? '一部承認' : '承認'
  const hasEntertainment = reviewed.some(r => r.result !== '却下' && r.category === '接待費')
  return {
    claim: {
      claim_id: claim.claim_id, employee_id: claim.employee_id, submit_date: claim.submit_date, status,
      item_count: reviewed.length, claimed_total: claimed, approved_total: approved,
      route: approvalRoute(employee, employees, approved, hasEntertainment).join('>'),
    },
    items: reviewed.map(r => ({
      claim_id: claim.claim_id, item_no: Number(r.item.item_no), date: r.item.date, category: r.category,
      claimed: Number(r.item.amount), approved: r.approved, result: r.result, code: r.code,
    })),
  }
}
