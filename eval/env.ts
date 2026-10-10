// The environment each eval run starts Claude Code in, and the record of it.
//
// Every run gets an empty HOME and CLAUDE_CONFIG_DIR of its own and only the
// environment variables listed here, so nothing from the host's ~/.claude
// (settings, skills, plugins, MCP servers, memory) or from an earlier run
// reaches it. Auth is CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`),
// passed through by name; this code never prints or stores its value.
// The eval measures Japanese use: the time zone is Japan's, whatever the host's.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk'

const PASS_THROUGH = ['PATH', 'CLAUDE_CODE_OAUTH_TOKEN']
export const FIXED_ENV = { TZ: 'Asia/Tokyo', LANG: 'C.UTF-8' }

// Credentials and providers the eval must not use: an API key or a cloud
// provider would bill differently and change what the session loads.
const FORBIDDEN = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

// The token file: `.env` at the repository root (ignored by git and by the
// image build), or EVAL_ENV_FILE. It is read only when the token is not
// already in the environment, and must be readable by its owner alone.
//   CLAUDE_CODE_OAUTH_TOKEN=...
const ENV_FILE = process.env.EVAL_ENV_FILE ?? fileURLToPath(new URL('../.env', import.meta.url))

const loadEnvFile = () => {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || !existsSync(ENV_FILE)) return
  if ((statSync(ENV_FILE).mode & 0o077) !== 0) throw new Error(`${ENV_FILE} is readable by others: chmod 600 it`)
  process.loadEnvFile(ENV_FILE)
}

// Refuses to start when the host environment names another credential, and
// returns which of the allowed variables are set (names only).
export const checkHostEnv = (opts: { needToken: boolean }) => {
  loadEnvFile()
  const present = FORBIDDEN.filter(k => process.env[k] !== undefined)
  if (present.length)
    throw new Error(`unset ${present.join(', ')}: the eval authenticates only with CLAUDE_CODE_OAUTH_TOKEN`)
  if (opts.needToken && !process.env.CLAUDE_CODE_OAUTH_TOKEN)
    throw new Error(`CLAUDE_CODE_OAUTH_TOKEN is not set: put it in ${ENV_FILE} (create one with \`claude setup-token\`)`)
  return PASS_THROUGH.filter(k => process.env[k] !== undefined)
}

// The env for one run, rooted at `home` (an empty directory the caller owns).
export const runEnv = async (home: string): Promise<Record<string, string>> => {
  const env: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ...FIXED_ENV }
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k]!
  await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true })
  return env
}

// Throws if `text` (about to be written to a results file) contains the token.
export const assertNoSecret = (text: string) => {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (token && token.length >= 8 && text.includes(token)) throw new Error('refusing to write: output contains the OAuth token')
}

const git = (...args: string[]) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

// The installed SDK (its package does not export package.json); its bundled
// CLI is the Claude Code version the init message reports.
const sdkVersion = () =>
  (JSON.parse(readFileSync(fileURLToPath(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)), 'utf8')) as { version: string }).version

// What is the same for every run of one eval invocation.
export const hostRecord = (extra: Record<string, unknown>) => ({
  sdkVersion: sdkVersion(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  // Set by container/run.sh; absent when run on the host directly.
  image: process.env.EVAL_IMAGE ?? null,
  gitCommit: process.env.EVAL_GIT_COMMIT ?? git('rev-parse', 'HEAD') ?? null,
  gitDirty: process.env.EVAL_GIT_DIRTY ? process.env.EVAL_GIT_DIRTY === '1' : git('status', '--porcelain') !== '',
  envNames: checkHostEnv({ needToken: false }),
  fixedEnv: FIXED_ENV,
  ...extra,
})

// The parts of the init message that describe what the session loaded
// (session id and cwd differ every run and are left out).
export const initRecord = (m: SDKSystemMessage) => ({
  claudeCodeVersion: m.claude_code_version,
  model: m.model,
  permissionMode: m.permissionMode,
  apiKeySource: m.apiKeySource,
  outputStyle: m.output_style,
  tools: [...m.tools].sort(),
  mcpServers: m.mcp_servers.map(s => `${s.name}:${s.status}`).sort(),
  skills: [...m.skills].sort(),
  agents: [...(m.agents ?? [])].sort(),
  plugins: m.plugins.map(p => (p as { source?: string }).source ?? p.name).sort(),
  pluginErrors: m.plugin_errors ?? [],
  slashCommands: [...m.slash_commands].sort(),
})
export type InitRecord = ReturnType<typeof initRecord>

export const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12)

// Why a session's init shows something the eval did not put there, if it does.
// `plugins` are the non-builtin plugins this arm loads. Skills are checked
// against the first run of the eval, so every run sees the same set.
export const contamination = (init: InitRecord, plugins: string[], firstSkills?: string[]): string | undefined => {
  if (init.apiKeySource !== 'none') return `apiKeySource is ${init.apiKeySource}, expected none (OAuth token)`
  if (init.mcpServers.length) return `MCP servers loaded: ${init.mcpServers.join(', ')}`
  if (init.pluginErrors.length) return `plugin errors: ${JSON.stringify(init.pluginErrors)}`
  const loaded = init.plugins.filter(p => !p.endsWith('@builtin'))
  const want = plugins.map(p => `${p}@inline`).sort()
  if (JSON.stringify(loaded) !== JSON.stringify(want)) return `plugins ${loaded.join(', ')}, expected ${want.join(', ')}`
  // Skills from an account or a plugin are namespaced (name:skill); the CLI's own are not.
  const foreign = init.skills.filter(s => s.includes(':') && !plugins.some(p => s.startsWith(`${p}:`)))
  if (foreign.length) return `skills from outside the eval: ${foreign.join(', ')}`
  if (firstSkills && JSON.stringify(init.skills) !== JSON.stringify(firstSkills))
    return `skills differ from the first run: ${init.skills.filter(s => !firstSkills.includes(s)).join(', ') || '(fewer)'}`
  return undefined
}
