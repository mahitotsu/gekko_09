// Counts business days (Mon-Fri) from `start` (inclusive) to `end` (exclusive).
// Dates are 'YYYY-MM-DD' strings.
export function businessDaysBetween(start, end) {
  let n = 0
  const d = new Date(start + 'T00:00:00Z')
  const stop = new Date(end + 'T00:00:00Z')
  while (d < stop) {
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) n++
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return n
}
