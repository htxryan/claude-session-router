export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// A model and effort to run the session on; null means keep the current one.
export type Choice = { family: Family; effort: Effort | null } | null

// What routing decided for this session. `applied` is the choice every
// main-loop request runs on until the person takes over: changing the model
// ends the switch, changing the effort ends only its effort part. `base` is
// the model and effort the session's own requests carried when the switch
// began, to notice those changes by.
export type Routing = {
  status: 'routed' | 'kept' | 'skipped'
  applied: { family: Family; model: string; effort: Effort | null } | null
  reason: string
  override?: 'model' | 'effort'
  base?: { model: string; effort?: Effort | number }
}

declare module 'claude-code' {
  interface PluginState {
    'session-router': { routing: Routing | null }
  }
}
