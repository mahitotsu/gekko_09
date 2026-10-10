// 請求の計算。請求業務規程（2026-09-01 改定）と、議事録の決定（第2回〜第4回）に従う。

export const SHIPPING_FEE = { A: 800, B: 1000, C: 1500 }
export const FREE_SHIPPING_FROM = 10000 // 注文の小計（税抜）がこの金額以上なら送料無料
export const DEALER_RATE = 90 // 特約店は単価の 90%（1円未満切り捨て）
export const VOLUME_MIN = 100 // 1 明細の数量がこれ以上なら数量割引
export const VOLUME_DISCOUNT = 5 // 数量割引 5%（割引額は1円未満切り捨て）

const pad = n => String(n).padStart(2, '0')
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate() // m は 1〜12

export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`
}

// 対象月 'YYYY-MM' と締め日（1〜28 または '末'）から、請求期間 [start, end] を返す。
export function billingPeriod(month, closingDay) {
  const [y, m] = month.split('-').map(Number)
  if (closingDay === '末') return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}` }
  const d = Number(closingDay)
  const [py, pm] = previousMonth(month).split('-')
  return { start: `${py}-${pm}-${pad(d + 1)}`, end: `${y}-${pad(m)}-${pad(d)}` }
}

// 端数処理: 金額 × 税率(%) / 100 を、顧客の方法で整数にする。整数演算で行う。
// 金額がマイナスのときは、絶対値で端数処理してから符号を戻す（規程 第7条4項）。
export function tax(amount, ratePercent, rounding) {
  if (amount < 0) return -tax(-amount, ratePercent, rounding)
  const n = amount * ratePercent // 100 倍した税額
  const q = Math.floor(n / 100)
  const r = n - q * 100
  if (rounding === '四捨五入') return r >= 50 ? q + 1 : q
  if (rounding === '切り上げ') return r > 0 ? q + 1 : q
  return q // 切り捨て（既定）
}

// 商品マスタの行の一覧（同じ商品の価格改定を含む）から、date 時点で有効な行。
// 適用開始日が date 以前の行のうち、もっとも新しいもの。なければ undefined。
export function priceRowAt(rows, date) {
  let best
  for (const r of rows ?? []) if (r.valid_from <= date && (!best || r.valid_from > best.valid_from)) best = r
  return best
}

export function unitPriceFor(customer, priceRow) {
  const base = Number(priceRow.unit_price)
  return customer.rank === '特約店' ? Math.floor((base * DEALER_RATE) / 100) : base
}

export function lineAmount(unitPrice, quantity) {
  const amount = unitPrice * quantity
  if (quantity < VOLUME_MIN) return amount
  return amount - Math.floor((amount * VOLUME_DISCOUNT) / 100)
}

// 元の注文の明細の、単価・金額・税率・商品名（注文日の価格で計算）。
export function originalLine(customer, orderRow, products) {
  const row = priceRowAt(products.get(orderRow.product_id), orderRow.order_date)
  const quantity = Number(orderRow.quantity)
  const unitPrice = unitPriceFor(customer, row)
  return { name: row.name, quantity, unitPrice, amount: lineAmount(unitPrice, quantity), rate: Number(row.tax_rate) }
}

// 返品の金額（マイナス）: 元の明細の金額 × 返品数量 ÷ 元の数量、1円未満切り捨て。
export function returnAmount(original, quantity) {
  return -Math.floor((original.amount * quantity) / original.quantity)
}

// 1 顧客分の請求書と明細。発行しない場合は null。
// data: { orders, products(Map: id → 行の配列), returns, payments, balances }
export function invoiceFor(month, customer, data) {
  const { orders, products, returns, payments, balances } = data
  const { start, end } = billingPeriod(month, customer.closing_day)
  const inPeriod = date => date >= start && date <= end
  const invoiceNo = `${month.replace('-', '')}-${customer.customer_id}`
  const rounding = customer.rounding || '切り捨て'

  // 注文: 確定で、注文日が期間内のもの。注文番号でまとめる（入力の順を保つ）。
  const byOrder = new Map()
  for (const row of orders) {
    if (row.customer_id !== customer.customer_id || row.status !== '確定' || !inPeriod(row.order_date)) continue
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, [])
    byOrder.get(row.order_id).push(row)
  }
  // 返品: 元の注文がこの顧客のもので、返品日が期間内のもの。
  const myReturns = returns.filter(r => {
    const o = orders.find(x => x.order_id === r.order_id)
    return o && o.customer_id === customer.customer_id && inPeriod(r.return_date)
  })

  const previous = Number(balances.find(b => b.customer_id === customer.customer_id && b.month === previousMonth(month))?.amount ?? 0)
  const payment = payments
    .filter(p => p.customer_id === customer.customer_id && inPeriod(p.payment_date))
    .reduce((s, p) => s + Number(p.amount), 0)

  if (byOrder.size === 0 && myReturns.length === 0 && previous === 0 && payment === 0) return null

  // 明細を (日付, 種類: 注文=0・返品=1, 番号) の順に並べる。
  const entries = []
  let subtotal10 = 0
  let subtotal8 = 0
  const add = (amount, rate) => {
    if (rate === 8) subtotal8 += amount
    else subtotal10 += amount
  }
  for (const [id, rows] of byOrder) {
    const date = rows[0].order_date
    const lines = []
    let orderSubtotal = 0
    for (const row of rows) {
      const l = originalLine(customer, row, products)
      orderSubtotal += l.amount
      add(l.amount, l.rate)
      lines.push({ line_type: '商品', order_id: id, date, product_id: row.product_id, product_name: l.name,
        quantity: l.quantity, unit_price: l.unitPrice, amount: l.amount, tax_rate: l.rate })
    }
    const fee = orderSubtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE[customer.zone]
    if (fee > 0) {
      add(fee, 10)
      lines.push({ line_type: '送料', order_id: id, date, product_id: 'SHIPPING', product_name: '送料',
        quantity: 1, unit_price: fee, amount: fee, tax_rate: 10 })
    }
    entries.push({ date, kind: 0, key: id, lines })
  }
  for (const r of myReturns) {
    const orderRow = orders.find(x => x.order_id === r.order_id && x.product_id === r.product_id)
    const original = originalLine(customer, orderRow, products)
    const quantity = Number(r.quantity)
    const amount = returnAmount(original, quantity)
    add(amount, original.rate)
    entries.push({ date: r.return_date, kind: 1, key: r.return_id, lines: [{ line_type: '返品', order_id: r.order_id,
      date: r.return_date, product_id: r.product_id, product_name: original.name, quantity: -quantity,
      unit_price: original.unitPrice, amount, tax_rate: original.rate }] })
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  entries.sort((a, b) => cmp(a.date, b.date) || a.kind - b.kind || cmp(a.key, b.key))

  const tax10 = tax(subtotal10, 10, rounding)
  const tax8 = tax(subtotal8, 8, rounding)
  const total = subtotal10 + tax10 + subtotal8 + tax8
  const carried = previous - payment
  return {
    invoice: {
      invoice_no: invoiceNo, customer_id: customer.customer_id, customer_name: customer.name,
      period_start: start, period_end: end, previous_balance: previous, payment, carried_over: carried,
      order_count: byOrder.size, return_count: myReturns.length,
      subtotal_10: subtotal10, tax_10: tax10, subtotal_8: subtotal8, tax_8: tax8, total, total_due: carried + total,
    },
    lines: entries.flatMap(e => e.lines).map(l => ({ invoice_no: invoiceNo, ...l })),
  }
}
