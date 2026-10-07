import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Effort, Routing } from '../types'
import {
  LATEST,
  allowedFamilies,
  asEffort,
  currentLabel,
  defaultEffortOf,
  familyOf,
  ignoresTopLevelEffort,
  isCloseEnough,
  isLatest,
  label,
  options as pickerOptions,
  parseRec,
  resolveAnswer,
  restrict,
  routerInput,
} from '../router/pick'
import type { Current } from '../router/pick'

const routing = atom({ plugin: 'session-router', key: 'routing' } as const, null)

// The session's effort, resolved as Claude Code does: CLAUDE_CODE_EFFORT_LEVEL,
// then the per-model setting, then a top-level effortLevel (which Opus 5.5 and
// later models ignore), then the model's own default. An --effort flag on the
// command line isn't visible to plugins.
async function readCurrent($: EngineInterface): Promise<Current> {
  const model = await $.session.model()
  const family = familyOf(model)
  if (family === 'haiku') return { family, model, effort: null }
  const settings = await $.settings.read()
  const perModel = (settings.modelSettings ?? {}) as Record<string, { effortLevel?: unknown } | undefined>
  const key = Object.keys(perModel).find(k => model.startsWith(k) || k.startsWith(model.replace(/\[.*\]$/, '')))
  const effort =
    asEffort(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) ??
    asEffort(key ? perModel[key]?.effortLevel : undefined) ??
    (ignoresTopLevelEffort(model) ? null : asEffort(settings.effortLevel)) ??
    defaultEffortOf(model)
  return { family, model, effort }
}

// How many times the model has replied in the main conversation. Local
// commands (/effort, /status) add transcript rows but no replies; /clear
// empties it; a resumed session already has some.
async function replies($: EngineInterface): Promise<number> {
  const api = await $.session.messages({ as: 'api' })
  return api.filter(m => m.role === 'assistant').length
}

// Whether /fast is on: it only speeds up Opus.
async function fastModeOn($: EngineInterface): Promise<boolean> {
  return (await $.config.list()).some(r => r.key === 'fast' && r.value === true)
}

// A turn Claude Code starts by itself to show the model a shell command's
// output (a prompt starting with !).
const isShellTurn = (text: string) => text.startsWith('<bash-')

async function log($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  const prev = await $.store.get('log')
  const rows = Array.isArray(prev) ? prev : []
  await $.store.set('log', [...rows, { at: await $.clock.now(), ...entry }].slice(-200))
}

function describe(r: Routing | null): string {
  if (!r) return 'Not routed yet: the next first prompt of a session (or after /clear) will be.'
  if (r.status !== 'routed' || !r.applied) {
    return `${r.status === 'kept' ? 'Kept the current model' : 'Routing skipped'}. ${r.reason}`
  }
  const note =
    r.override === 'model'
      ? ' You have since changed the model yourself, so the switch has ended.'
      : r.override === 'effort'
        ? ' You have since changed the effort yourself; the model switch still applies.'
        : ''
  return `Routed to ${label(r.applied.family, r.applied.effort)}. ${r.reason}${note}`
}

async function settle($: EngineInterface, value: Routing | null, statusLine?: string) {
  await update($, routing, () => value)
  $.ui.status(statusLine)
}

// The choose-model skill is the router's instructions: the same file a person
// can run directly as /session-router:choose-model.
async function readSkill($: EngineInterface): Promise<string> {
  const text = await $.fs.read(`${$.plugin.root}/skills/choose-model/SKILL.md`)
  return text.startsWith('---') ? text.slice(text.indexOf('---', 3) + 3).trim() : text.trim()
}

// A line in the transcript the person sees (the engine names the plugin) and
// a notice row in the session file the model never reads.
async function notice($: EngineInterface, text: string): Promise<void> {
  try {
    $.ui.log(text)
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `Model router: ${text}` }] } })
  } catch (err) {
    $.ui.log(`session-router: couldn't add the notice: ${String(err)}`, { to: 'debug' })
  }
}

// Whether the person has changed the model or the effort since the switch
// began: the session's own request carries a different one, or /model or
// /effort reported setting one (picking the session's original model changes
// nothing visible but still means "stop switching").
async function takenOver(
  $: EngineInterface,
  r: Routing,
  e: { model: string; effort?: Effort | number },
  watching: Map<'model' | 'effort', number>,
): Promise<Routing['override']> {
  const said = async (command: 'model' | 'effort', text: string) => {
    const from = watching.get(command)
    if (from === undefined) return false
    watching.delete(command)
    return (await $.session.messages()).slice(from).some(m => m.text.includes(`<local-command-stdout>${text}`))
  }
  if (!r.base) {
    watching.clear() // what was picked before the switch began is its starting point
    return r.override
  }
  if (e.model !== r.base.model || (await said('model', 'Set model to'))) return 'model'
  if (e.effort !== r.base.effort || (await said('effort', 'Set effort level to'))) return 'effort'
  return r.override
}

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`)

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'balanced')
  const remoteMode = String(options.remoteMode ?? 'ask')
  const prefix = String(options.bypassPrefix ?? '')
  const allowed = allowedFamilies(options.excludeModels)
  const timeoutMs = Number(options.timeoutMs ?? 30000)

  // Per-session bookkeeping, reset by /clear.
  let checked = false // the first routed turn's answering model was checked
  let baseReplies = 0 // replies to shell commands run before the first prompt
  let shellTurn: string | null = null
  let cancelled = false // Esc cancelled the prompt while routing
  // The decision, noted under the prompt once its turn starts (a plugin's
  // append made after the prompt is handed on does not land).
  let pending: string | null = null
  // /model or /effort run since the last request, with the transcript's length then.
  const watching = new Map<'model' | 'effort', number>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'router', description: 'Shows which model this session was routed to, and why.' })
    return next(e)
  })

  on('command.run', { command: 'router' }, async $ => ({ text: describe(await read($, routing)) }))

  // /model and /effort return before their dialog closes; note where the
  // transcript stood so the next request can tell a pick ("Set model to …")
  // from Esc ("Kept model as …").
  on('command.run', async ($, e, next) => {
    if (e.command === 'model' || e.command === 'effort') watching.set(e.command, (await $.session.messages()).length)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear ends the session without a new session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      checked = cancelled = false
      watching.clear()
      baseReplies = 0
      shellTurn = pending = null
      await settle($, null)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the very first prompt of a session: never once the model has
    // replied, and never for a prompt typed while the first turn runs.
    if (e.turnId !== undefined) return next(e)
    if ((await read($, routing)) !== null || (await replies($)) > baseReplies) return next(e)
    // This plugin's own commands (asking choose-model for advice) aren't work to route.
    if (e.text.trimStart().startsWith('/session-router:')) return next(e)

    // Your Enter in the terminal, the desktop app (an SDK host with a surface
    // attached), or Remote Control. Headless runs, notifications, peers and
    // schedules pass through unrouted.
    const kind = e.origin.kind
    const isPerson = kind === 'composer' || kind === 'bridge' || (kind === 'sdk' && (await $.session.surfaces()).length > 0)
    if (!isPerson) return next(e)
    const isRemote = kind === 'bridge'

    // Records the decision and sends the prompt on, noting it once the turn starts.
    const decide = async (value: Routing, text: string, statusLine?: string, logged: Record<string, unknown> = {}, sent = e) => {
      await settle($, value, statusLine)
      await log($, { origin: kind, excerpt: e.text.slice(0, 200), status: value.status, reason: value.reason, ...logged })
      pending = text
      return next(sent)
    }
    const skipped = (reason: string): Routing => ({ status: 'skipped', applied: null, reason })
    const kept = (reason: string): Routing => ({ status: 'kept', applied: null, reason })

    if (isRemote && remoteMode === 'skip') {
      return decide(skipped('Remote Control sessions are set to skip routing.'), 'skipped (Remote Control sessions are set to skip routing).')
    }
    const typed = e.text.trimStart()
    if (prefix && typed.startsWith(prefix) && typed.slice(prefix.length).trim() !== '') {
      const text = typed.slice(prefix.length).trimStart()
      return decide(skipped(`Bypassed with ${prefix}.`), `skipped for this session (${prefix} prefix).`, undefined, {}, { ...e, text })
    }

    const current = await readCurrent($)
    const now = currentLabel(current)
    $.ui.status('routing…')
    const reply = await $.model.complete(
      {
        model: String(options.routerModel ?? 'claude-opus-5-5'),
        system: await readSkill($),
        prompt: routerInput({
          prompt: e.text,
          current,
          cwd: await $.session.cwd(),
          mode,
          hasImages: (e.attachments ?? []).some(a => a.type === 'image'),
          preferences: [],
          models: allowed,
        }),
        effort: asEffort(options.routerEffort) ?? 'medium',
        maxTokens: 1024,
        timeoutMs,
      },
      { signal: next.signal },
    )
    // Esc while routing cancels the prompt; route it again when it's resent.
    if (next.signal.aborted) {
      $.ui.status(undefined)
      cancelled = true
      return next(e)
    }
    const parsed = reply.isAnswered ? parseRec(reply.text) : null
    const rec = parsed && restrict(parsed, allowed)
    const why = rec ? ` Why: ${rec.reason}` : ''

    if (!rec) {
      const failure = reply.isAnswered ? 'unreadable reply' : reply.reason === 'aborted' ? `timed out after ${duration(timeoutMs)}` : reply.reason
      return decide(skipped(`Router unavailable (${failure}).`), `unavailable (${failure}); this session stays on ${now}.`)
    }
    const suggested = rec.family === 'keep' ? `keeping ${now}` : label(rec.family, rec.effort)

    if (options.shadow === true) {
      const would = rec.family === 'keep' ? 'keep the current model' : `pick ${suggested}`
      return decide(kept(`Shadow mode: would ${would}. ${rec.reason}`), `shadow mode, would ${would}; staying on ${now}.${why}`)
    }

    const askAnyway = options.askWhenClose === true && (rec.family !== 'keep' || rec.alternative !== null)
    if (!askAnyway && (rec.family === 'keep' || isCloseEnough(rec, current))) {
      const close = rec.family === 'keep' ? 'no reason to switch' : `close enough to its pick, ${suggested}`
      return decide(kept(rec.reason), `staying on ${now} (${close}).${why}`, `kept ${now}`)
    }

    let choice: Choice = null
    let answer: string | null = null
    if (isRemote && remoteMode === 'auto') {
      choice = rec.family === 'keep' ? null : { family: rec.family, effort: rec.effort }
    } else {
      const opts = pickerOptions(rec, current)
      const fastNote =
        rec.family !== 'keep' && rec.family !== 'opus' && (await fastModeOn($)) ? ' (Fast mode only applies to Opus.)' : ''
      const question = rec.family === 'keep' ? `Keep ${now}?` : `Run this session on ${suggested}?${fastNote}`
      try {
        answer = await $.ui.ask(`${rec.reason} ${question}`, { header: 'Model', options: opts.map(o => o.label) })
        const resolved = resolveAnswer(answer, opts, rec)
        if (resolved === 'unrecognized') $.ui.toast(`Didn't recognize "${answer}"; staying on ${now}`)
        else choice = resolved
      } catch {
        // Esc, or the surface couldn't show the picker: keep the current model.
      }
    }

    const isSame =
      choice !== null &&
      isLatest(current.model) &&
      choice.family === current.family &&
      (choice.effort === null || choice.effort === current.effort)
    if (choice === null || isSame) {
      const how = answer === null ? 'picker dismissed' : 'you kept it'
      return decide(kept(rec.reason), `staying on ${now} (${how}; it suggested ${suggested}).${why}`, `kept ${now}`, { answer })
    }

    const applied = { family: choice.family, model: LATEST[choice.family].id, effort: choice.effort }
    const picked = label(choice.family, choice.effort)
    const how =
      answer === null ? 'applied automatically over Remote Control' : picked === suggested ? 'recommended' : `your pick; it suggested ${suggested}`
    return decide(
      { status: 'routed', applied, reason: rec.reason },
      `this session runs on ${picked} (${how}; was ${now}).${why}`,
      `→ ${picked}`,
      { answer, applied },
    )
  }).catch(($, e, next) => {
    // Never eat the prompt: any failure sends it on the current model.
    $.ui.status(undefined)
    return next(e)
  })

  // A turn that starts with routing still undecided (a resumed session, a
  // notification or a skipped first prompt) closes routing for the session.
  on('turn.start', async ($, e, next) => {
    if (cancelled) {
      cancelled = false
      return next(e)
    }
    const undecided = (await read($, routing)) === null
    if (undecided && isShellTurn(e.text)) {
      shellTurn = e.turnId
      return next(e)
    }
    if (pending !== null) {
      await notice($, pending)
      pending = null
    }
    if (undecided) await settle($, { status: 'skipped', applied: null, reason: 'The session was already under way.' })
    return next(e)
  })

  // Every main-loop request of the session runs on the choice. Done per request
  // on purpose: /model would also save the choice as the default for every
  // future session. Subagents keep their own models. When the person changes
  // the model (or the effort) themselves, that change wins from then on.
  on('turn.step', async function* ($, e, next) {
    const r = await read($, routing)
    const applied = r?.status === 'routed' && r.override !== 'model' ? r.applied : null
    if (!r || !applied || e.agentId !== undefined) return yield* next(e)
    const override = await takenOver($, r, e, watching)
    if (!r.base || override !== r.override) {
      const status = override === 'model' ? undefined : `→ ${override ? LATEST[applied.family].name : label(applied.family, applied.effort)}`
      await settle($, { ...r, base: r.base ?? { model: e.model, effort: e.effort }, override }, status)
    }
    if (override === 'model') return yield* next(e)
    const effort = applied.effort && !override ? { effort: applied.effort } : {}
    return yield* next({ ...e, model: applied.model, ...effort })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (e.turnId === shellTurn) {
      shellTurn = null
      baseReplies = await replies($)
    }
    // Once, after the first routed turn: say so if another model answered
    // (a fallback or an allowlist substitution).
    const r = await read($, routing)
    if (checked || r?.status !== 'routed' || !r.applied) return result
    checked = true
    const used = e.usage?.model
    if (used && familyOf(used) !== r.applied.family) {
      await notice($, `asked for ${LATEST[r.applied.family].name}, but ${used} answered (a fallback or an allowlist substitution).`)
    }
    return result
  })
}
