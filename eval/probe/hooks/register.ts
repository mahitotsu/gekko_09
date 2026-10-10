import type { Register } from 'claude-code'

// One line per model request, for eval/run.ts to collect:
//   eval-probe {"turn":"…","index":0,"model":"claude-opus-5-5","effort":"high",…}
// `model` and `effort` are what this hook received, so they are what the
// request was sent with only when this mod runs after every mod that rewrites
// them; `answered` is the model the API reports, which eval/run.ts compares
// against `model` to catch the wrong order.
const PREFIX = 'eval-probe ' // eval/run.ts matches this

// Once per session, at the first turn: the settings the session runs with
// that change what Claude reads, so a run that lost them is caught.
//   eval-probe-settings {"language":"japanese"}
const SETTINGS_PREFIX = 'eval-probe-settings '
let settingsLogged = false

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    if (!settingsLogged) {
      settingsLogged = true
      const s = await $.settings.read()
      $.ui.log(SETTINGS_PREFIX + JSON.stringify({ language: s.language ?? null }))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const started = await $.clock.now()
    const r = yield* next(e)
    const u = r.usage
    $.ui.log(
      PREFIX +
        JSON.stringify({
          turn: e.turnId,
          index: e.index,
          agent: e.agentId ?? null,
          model: e.model,
          effort: e.effort ?? null,
          messages: e.messageCount,
          answered: u?.model ?? null,
          in: u?.input_tokens ?? 0,
          cacheRead: u?.cache_read_input_tokens ?? 0,
          cacheWrite: u?.cache_creation_input_tokens ?? 0,
          out: u?.output_tokens ?? 0,
          stop: r.stopReason,
          ms: (await $.clock.now()) - started,
        }),
    )
    return r
  })
}
