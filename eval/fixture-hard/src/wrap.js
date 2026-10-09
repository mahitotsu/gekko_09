// See docs/wrap.md.
// TODO: this counts characters, not display width, and ignores words and kinsoku.
export function wrapText(text, width) {
  const lines = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines
}
