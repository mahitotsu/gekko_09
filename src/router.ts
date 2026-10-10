import { fileURLToPath } from 'node:url'

import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

export const ROUTER_DIR = fileURLToPath(new URL('../plugins/model-router', import.meta.url))

export type RouterOptions = {
  mainRouting?: 'route' | 'fixed'
  classifier?: 'heuristic' | 'hybrid' | 'haiku'
  stickyContextTokens?: number
  subagentRouting?: boolean
  report?: 'turn' | 'off'
}

// Options that load the model-router mod into the Claude Code process the SDK
// starts. `model` stays the session's default: the router rewrites each
// request from there, and with `mainRouting: 'fixed'` it is the main model.
export const withRouter = (base: Options, router: RouterOptions = {}): Options => ({
  ...base,
  plugins: [...(base.plugins ?? []), { type: 'local', path: ROUTER_DIR }],
  settings: {
    ...(typeof base.settings === 'object' ? base.settings : {}),
    pluginConfigs: { 'model-router': { options: { ...router } } },
  },
})

// The mod's per-turn line ("model-router: opus (...) · turn $0.0123") reaches
// an SDK host as a `ui_log` message; it is not in the SDK's typed union yet,
// so it is read loosely.
export const routerLine = (m: SDKMessage): string | undefined => {
  const any = m as { type?: string; subtype?: string; text?: string; content?: string }
  const text = any.text ?? any.content
  if ((any.type === 'ui_log' || any.subtype === 'ui_log') && typeof text === 'string') return text
  return undefined
}

export const summarize = (r: SDKResultMessage) => {
  const perModel = Object.entries(r.modelUsage).map(([model, u]) => ({
    model,
    in: u.inputTokens,
    cacheRead: u.cacheReadInputTokens,
    cacheWrite: u.cacheCreationInputTokens,
    out: u.outputTokens,
    usd: Number(u.costUSD.toFixed(4)),
  }))
  return { costUsd: r.total_cost_usd, durationMs: r.duration_ms, turns: r.num_turns, perModel }
}
