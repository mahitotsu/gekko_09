// Display width of one character: 2 for East Asian wide/fullwidth, else 1.
const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
]

export function charWidth(ch) {
  const cp = ch.codePointAt(0)
  return WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1
}

export function stringWidth(s) {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}
