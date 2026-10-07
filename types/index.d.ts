export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// A model and effort to run the session on; null means keep the current one.
export type Choice = { family: Family; effort: Effort | null } | null

// What routing decided for this session. `applied` is the choice every
// main-loop request runs on: /model ends the switch (`overridden`), /effort
// ends only the effort part (`effortOverridden`).
export type Routing = {
  status: 'routed' | 'kept' | 'skipped'
  applied: { family: Family; model: string; effort: Effort | null } | null
  reason: string
  overridden: boolean
  effortOverridden?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-router': { routing: Routing | null }
  }
}
