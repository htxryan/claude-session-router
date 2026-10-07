import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Effort, Routing } from '../types'
import {
  EFFORTS,
  allowedFamilies,
  LATEST,
  currentLabel,
  defaultEffortOf,
  familyOf,
  isLatest,
  isCloseEnough,
  label,
  options as pickerOptions,
  parseRec,
  resolveAnswer,
  restrict,
  routerInput,
} from '../router/pick'
import type { Current, Rec } from '../router/pick'

const routing = atom({ plugin: 'session-router', key: 'routing' } as const, null)

const asEffort = (v: unknown): Effort | null =>
  typeof v === 'string' && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : null

// The session's effort, resolved as Claude Code does: --effort or
// CLAUDE_CODE_EFFORT_LEVEL, then the per-model setting, then the model's own
// default (a top-level effortLevel in user settings doesn't apply to the 5.5
// models).
async function readCurrent($: EngineInterface): Promise<Current> {
  const model = await $.session.model()
  const family = familyOf(model)
  if (family === 'haiku') return { family, model, effort: null }
  const settings = await $.settings.read()
  const perModel = (settings.modelSettings ?? {}) as Record<string, { effortLevel?: unknown } | undefined>
  const key = Object.keys(perModel).find(k => model.startsWith(k) || k.startsWith(model.replace(/\[.*\]$/, '')))
  const effort =
    asEffort(await $.env.get('CLAUDE_EFFORT')) ??
    asEffort(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) ??
    asEffort(key ? perModel[key]?.effortLevel : undefined) ??
    (family ? defaultEffortOf(model) : asEffort(settings.effortLevel))
  return { family, model, effort }
}

async function log($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  const prev = await $.store.get('log')
  const rows = Array.isArray(prev) ? prev : []
  await $.store.set('log', [...rows, { at: await $.clock.now(), ...entry }].slice(-200))
}

function describe(r: Routing | null): string {
  if (!r) return 'Not routed yet: the next first prompt of a session (or after /clear) will be.'
  const what =
    r.status === 'routed' && r.applied
      ? `Routed to ${label(r.applied.family, r.applied.effort)}`
      : r.status === 'kept'
        ? 'Kept the current model'
        : 'Routing skipped'
  const note =
    r.status !== 'routed' ? ''
    : r.overridden ? ' You have since changed the model yourself, so the switch has ended.'
    : r.effortOverridden ? ' You have since changed the effort yourself; the model switch still applies.'
    : ''
  return `${what}. ${r.reason}${note}`
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

const why = (reason: string) => ` Why: ${reason}`

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'balanced')
  const remoteMode = String(options.remoteMode ?? 'ask')
  const prefix = String(options.bypassPrefix ?? '')
  const allowed = allowedFamilies(options.excludeModels)
  let checked = false
  // Claude Code keeps counting turns across /clear; routing compares with the
  // count at the last /clear.
  let baseTurns = 0
  // Set when Esc cancels the prompt while routing: the turn Claude Code still
  // starts for it doesn't count as the session getting under way.
  let cancelled = false
  // The decision, noted under the prompt once its turn starts (a plugin's
  // append made after the prompt is handed on does not land).
  let pending: string | null = null
  const announce = <E, R>(next: (e: E) => R, e: E, text: string): R => {
    pending = text
    return next(e)
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: "Shows which model this session was routed to, and why.",
    })
    return next(e)
  })

  on('command.run', { command: 'router' }, async $ => ({ text: describe(await read($, routing)) }))

  // The person changing the model ends the switch; changing the effort ends
  // only the effort part of it.
  on('command.run', async ($, e, next) => {
    if (e.command === 'model') {
      await update($, routing, r => (r && r.status === 'routed' ? { ...r, overridden: true } : r))
    }
    if (e.command === 'effort') {
      await update($, routing, r => (r && r.status === 'routed' ? { ...r, effortOverridden: true } : r))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear ends the session without a new session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      baseTurns = await $.session.turns()
      checked = false
      cancelled = false
      pending = null
      await settle($, null)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the very first prompt of a session: never once any turn has run,
    // and never for a prompt typed while the first turn is still running.
    if (e.turnId !== undefined) return next(e)
    if ((await read($, routing)) !== null || (await $.session.turns()) > baseTurns) return next(e)
    // This plugin's own commands (asking choose-model for advice) aren't work to route.
    if (e.text.trimStart().startsWith('/session-router:')) return next(e)

    const kind = e.origin.kind
    const surfaces = await $.session.surfaces()
    // Your Enter in the terminal, the desktop app (an SDK host with a surface
    // attached), or Remote Control. Headless runs, notifications, peers and
    // schedules pass through unrouted.
    const isPerson = kind === 'composer' || kind === 'bridge' || (kind === 'sdk' && surfaces.length > 0)
    if (!isPerson) return next(e)
    const isRemote = kind === 'bridge'

    if (isRemote && remoteMode === 'skip') {
      await settle($, { status: 'skipped', applied: null, reason: 'Remote Control sessions are set to skip routing.', overridden: false })
      return announce(next, e, 'skipped (Remote Control sessions are set to skip routing).')
    }
    if (prefix && e.text.startsWith(prefix)) {
      await settle($, { status: 'skipped', applied: null, reason: `Bypassed with ${prefix}.`, overridden: false })
      return announce(next, { ...e, text: e.text.slice(prefix.length).trimStart() }, `skipped for this session (${prefix} prefix).`)
    }

    const current = await readCurrent($)
    const timeoutMs = Number(options.timeoutMs ?? 30000)
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
    const rec: Rec | null = parsed && restrict(parsed, allowed)
    const entry = { origin: kind, project: await $.session.cwd(), excerpt: e.text.slice(0, 200), current, rec }

    if (!rec) {
      const failure = reply.isAnswered
        ? 'unreadable reply'
        : reply.reason === 'aborted'
          ? `timed out after ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}`
          : reply.reason
      await settle($, { status: 'skipped', applied: null, reason: `Router unavailable (${failure}).`, overridden: false })
      await log($, { ...entry, outcome: 'router-failed' })
      return announce(next, e, `unavailable (${failure}); this session stays on ${currentLabel(current)}.`)
    }

    if (options.shadow === true) {
      const would = rec.family === 'keep' ? 'keep the current model' : label(rec.family, rec.effort)
      await settle($, { status: 'kept', applied: null, reason: `Shadow mode: would ${would}. ${rec.reason}`, overridden: false })
      await log($, { ...entry, outcome: 'shadow' })
      return announce(next, e, `shadow mode, would pick ${would}; staying on ${currentLabel(current)}.${why(rec.reason)}`)
    }

    const askAnyway = options.askWhenClose === true && (rec.family !== 'keep' || rec.alternative !== null)
    if (!askAnyway && (rec.family === 'keep' || isCloseEnough(rec, current))) {
      await settle($, { status: 'kept', applied: null, reason: rec.reason, overridden: false }, `kept ${currentLabel(current)}`)
      await log($, { ...entry, outcome: 'close-enough' })
      const close = rec.family === 'keep' ? 'no reason to switch' : `close enough to its pick, ${label(rec.family, rec.effort)}`
      return announce(next, e, `staying on ${currentLabel(current)} (${close}).${why(rec.reason)}`)
    }

    let choice: Choice
    let answer: string | null = null
    if (isRemote && remoteMode === 'auto') {
      choice = rec.family === 'keep' ? null : { family: rec.family, effort: rec.effort }
    } else {
      const opts = pickerOptions(rec, current)
      try {
        const question =
          rec.family === 'keep' ? `Keep ${currentLabel(current)}?` : `Run this session on ${label(rec.family, rec.effort)}?`
        answer = await $.ui.ask(`${rec.reason} ${question}`, {
          header: 'Model',
          options: opts.map(o => o.label),
        })
        const resolved = resolveAnswer(answer, opts)
        if (resolved === 'unrecognized') $.ui.toast(`Didn't recognize "${answer}"; staying on ${currentLabel(current)}`)
        choice = resolved === 'unrecognized' ? null : resolved
      } catch {
        choice = null // Esc, or the surface couldn't show the picker: keep the current model
      }
    }

    const suggested = rec.family === 'keep' ? `keeping ${currentLabel(current)}` : label(rec.family, rec.effort)
    const isSame =
      choice !== null &&
      isLatest(current.model) &&
      choice.family === current.family &&
      (choice.effort === null || choice.effort === current.effort)
    if (choice === null || isSame) {
      await settle($, { status: 'kept', applied: null, reason: rec.reason, overridden: false }, `kept ${currentLabel(current)}`)
      await log($, { ...entry, answer, outcome: 'kept' })
      const how = answer === null ? 'picker dismissed' : 'you kept it'
      return announce(next, e, `staying on ${currentLabel(current)} (${how}; it suggested ${suggested}).${why(rec.reason)}`)
    }

    const applied = { family: choice.family, model: LATEST[choice.family].id, effort: choice.effort }
    const picked = label(choice.family, choice.effort)
    await settle($, { status: 'routed', applied, reason: rec.reason, overridden: false }, `→ ${picked}`)
    await log($, { ...entry, answer, outcome: 'routed', applied })
    const how =
      answer === null ? 'applied automatically over Remote Control' : picked === suggested ? 'recommended' : `your pick; it suggested ${suggested}`
    return announce(next, e, `this session runs on ${picked} (${how}; was ${currentLabel(current)}).${why(rec.reason)}`)
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
    if (pending !== null) {
      const text = pending
      pending = null
      await notice($, text)
    }
    if ((await read($, routing)) === null) {
      const closed: Routing = { status: 'skipped', applied: null, reason: 'The session was already under way.', overridden: false }
      await update($, routing, () => closed)
    }
    return next(e)
  })

  // Every main-loop request of the session runs on the choice. Done per request
  // on purpose: /model would also save the choice as the default for every
  // future session. Subagents keep their own models.
  on('turn.step', async function* ($, e, next) {
    const r = await read($, routing)
    const applied = r && r.status === 'routed' && !r.overridden ? r.applied : null
    if (!applied || e.agentId !== undefined) return yield* next(e)
    const effort = applied.effort && applied.family !== 'haiku' && !r?.effortOverridden ? { effort: applied.effort } : {}
    return yield* next({ ...e, model: applied.model, ...effort })
  })

  // Once, after the first routed turn: say so if another model answered
  // (a fallback or an allowlist substitution).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || checked) return result
    const r = await read($, routing)
    if (!r || r.status !== 'routed' || !r.applied) return result
    checked = true
    const used = e.usage?.model
    if (used && familyOf(used) !== r.applied.family) {
      await notice($, `asked for ${LATEST[r.applied.family].name}, but ${used} answered (a fallback or an allowlist substitution).`)
    }
    return result
  })
}
