// Parses simple CSV text into an array of rows (arrays of strings).
// TODO: handle CRLF line endings
export function parseCsv(text) {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => line.split(','))
}

export function toCsv(rows) {
  return rows.map(r => r.join(',')).join('\n')
}
