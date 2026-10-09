import { debounce } from './debounce.js'

// Saves the document a while after the user stops typing, and on close.
export class AutoSaver {
  constructor(save, delayMs = 1000) {
    this.save = save
    this.debounced = debounce(content => this.save(content), delayMs)
  }

  edit(content) {
    this.debounced(content)
  }

  close() {
    this.debounced.flush()
  }

  discard() {
    this.debounced.cancel()
  }
}
