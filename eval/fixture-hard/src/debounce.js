// Calls fn once calls have stopped for `ms` milliseconds, with the latest arguments.
// flush() runs a pending call right away; cancel() drops it.
export function debounce(fn, ms) {
  let timer = null
  let pendingArgs = null

  const debounced = (...args) => {
    if (timer) return
    pendingArgs = args
    timer = setTimeout(() => {
      timer = null
      fn(...pendingArgs)
    }, ms)
  }

  debounced.flush = () => {
    if (pendingArgs) fn(...pendingArgs)
  }

  debounced.cancel = () => {
    clearTimeout(timer)
    timer = null
  }

  return debounced
}
