export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// A model and effort to run the session on; null means keep the current one.
export type Choice = { family: Family; effort: Effort | null } | null

// What routing decided for this session. `applied` is the choice every
// main-loop request runs on until the person takes over: /model ends the
// switch, /effort ends only its effort part.
export type Routing = {
  status: 'routed' | 'kept' | 'skipped'
  applied: { family: Family; model: string; effort: Effort | null } | null
  reason: string
  override?: 'model' | 'effort'
}

declare module 'claude-code' {
  interface PluginState {
    'session-router': { routing: Routing | null }
  }
}
