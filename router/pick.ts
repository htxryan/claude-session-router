// Pure routing logic: what the router sees, how its reply is read, and how
// the person's answer in the picker becomes a choice. No `$` here.

import type { Effort, Family, Choice } from '../types'

export const FAMILIES: readonly Family[] = ['fable', 'opus', 'sonnet', 'haiku']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The latest model of each family, for the per-request rewrite. Update when a
// family gets a new model.
export const LATEST: Record<Family, { id: string; name: string }> = {
  fable: { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  opus: { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  haiku: { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
}

// What each family runs at in Claude Code when nobody names an effort.
export const DEFAULT_EFFORT: Record<Exclude<Family, 'haiku'>, Effort> = { fable: 'high', opus: 'medium', sonnet: 'medium' }

const effortFor = (family: Family, effort: Effort | null): Effort | null =>
  family === 'haiku' ? null : (effort ?? DEFAULT_EFFORT[family])

export type Rec = {
  family: Family | 'keep'
  effort: Effort | null
  reason: string
  confidence: number
  alternative: { family: Family; effort: Effort | null; why: string } | null
}

export type Current = { family: Family | null; model: string; effort: Effort | null }

export const familyOf = (model: string): Family | null =>
  FAMILIES.find(f => model.toLowerCase().includes(f)) ?? null

// The model ID without a context suffix ("[1m]") or a date stamp.
const baseId = (model: string): string => model.toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')

// Whether this is the latest model of its family, the one the router switches to.
export const isLatest = (model: string): boolean => {
  const family = familyOf(model)
  return family !== null && baseId(model) === LATEST[family].id
}

// A readable name for any Claude model ID: "claude-opus-4-8" is "Opus 4.8".
export function modelName(model: string): string {
  const family = familyOf(model)
  if (!family) return model
  if (isLatest(model)) return LATEST[family].name
  const version = baseId(model).split(`${family}-`)[1]?.match(/^\d+(-\d+)?/)?.[0]
  const title = family[0]!.toUpperCase() + family.slice(1)
  return version ? `${title} ${version.replace('-', '.')}` : model
}

// The effort a model runs at in Claude Code when nobody sets one.
export function defaultEffortOf(model: string): Effort | null {
  const family = familyOf(model)
  if (family === 'haiku') return null
  if (family && isLatest(model)) return DEFAULT_EFFORT[family]
  return baseId(model).includes('opus-4-7') ? 'xhigh' : 'high'
}

const asEffort = (v: unknown): Effort | null => {
  const effort = typeof v === 'string' ? v.toLowerCase().replace(/[^a-z]/g, '') : ''
  return (EFFORTS as readonly string[]).includes(effort) ? (effort as Effort) : null
}

// A family from the router's reply, forgiving about case and full model IDs
// ("Sonnet", "claude-sonnet-5-5").
const asFamily = (v: unknown): Family | null =>
  typeof v === 'string' ? (FAMILIES.find(f => v.toLowerCase().includes(f)) ?? null) : null

// The families the router may recommend, from the excludeModels setting
// ("fable" or "fable, haiku"). Unknown words are ignored.
export function allowedFamilies(exclude: unknown): Family[] {
  const words = typeof exclude === 'string' ? exclude.toLowerCase().split(/[^a-z]+/) : []
  return FAMILIES.filter(f => !words.includes(f))
}

// Every label names an effort, except Haiku's: it has no effort levels.
export const label = (family: Family, effort: Effort | null): string =>
  family === 'haiku' ? LATEST[family].name : `${LATEST[family].name} · ${effort ?? 'default effort'}`

export const currentLabel = (c: Current): string =>
  c.family === 'haiku' ? modelName(c.model) : `${modelName(c.model)} · ${c.effort ?? 'default effort'}`

export function routerInput(args: {
  prompt: string
  current: Current
  cwd: string
  mode: string
  hasImages: boolean
  preferences: readonly string[]
  models: readonly Family[]
}): string {
  const prompt = args.prompt.length > 8000 ? `${args.prompt.slice(0, 8000)}\n[truncated]` : args.prompt
  return JSON.stringify(
    {
      prompt,
      current: { model: args.current.model, effort: args.current.effort ?? 'unknown' },
      project: args.cwd.split('/').filter(Boolean).slice(-2).join('/'),
      signals: { promptChars: args.prompt.length, hasImages: args.hasImages },
      mode: args.mode,
      models: args.models,
      preferences: args.preferences,
    },
    null,
    2,
  )
}

// Reads the router's reply; null when it is not the contract.
export function parseRec(text: string): Rec | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  if (!reason) return null
  const family = String(raw.model).toLowerCase() === 'keep' ? 'keep' : asFamily(raw.model)
  if (family === null) return null
  const effort = family === 'keep' ? null : effortFor(family, asEffort(raw.effort))
  const alt = raw.alternative as Record<string, unknown> | null | undefined
  const altFamily = alt ? asFamily(alt.model) : null
  return {
    family,
    effort,
    reason,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    alternative:
      alt && altFamily
        ? {
            family: altFamily,
            effort: effortFor(altFamily, asEffort(alt.effort)),
            why: typeof alt.why === 'string' ? alt.why : '',
          }
        : null,
  }
}

// Holds the router to the allowed families: an excluded pick gives way to an
// allowed runner-up, or else to keeping the current model; an excluded
// runner-up is dropped.
export function restrict(rec: Rec, allowed: readonly Family[]): Rec {
  const ok = (f: Family) => allowed.includes(f)
  const alternative = rec.alternative && ok(rec.alternative.family) ? rec.alternative : null
  if (rec.family === 'keep' || ok(rec.family)) return { ...rec, alternative }
  const excluded = `${LATEST[rec.family].name} is excluded in your settings`
  if (alternative) {
    return { ...rec, family: alternative.family, effort: alternative.effort, reason: `${rec.reason} (${excluded}, so this is the runner-up.)`, alternative: null }
  }
  return { ...rec, family: 'keep', effort: null, reason: `${rec.reason} (${excluded}.)`, alternative: null }
}

const effortGap = (a: Effort | null, b: Effort | null): number | null =>
  a === null || b === null ? null : Math.abs(EFFORTS.indexOf(a) - EFFORTS.indexOf(b))

// True when the pick is close enough to the current setting that asking would
// only nag: same family and effort within one level (or no effort involved).
export function isCloseEnough(rec: Rec, current: Current): boolean {
  if (rec.family === 'keep') return true
  if (rec.family !== current.family || !isLatest(current.model)) return false
  if (rec.family === 'haiku' || rec.effort === null) return true
  const gap = effortGap(rec.effort, current.effort)
  return gap !== null && gap < 2
}

export type Option = { label: string; choice: Choice }

export function options(rec: Rec, current: Current): Option[] {
  const out: Option[] = []
  if (rec.family !== 'keep') {
    out.push({
      label: `${label(rec.family, rec.effort)} (Recommended)`,
      choice: { family: rec.family, effort: rec.effort },
    })
  }
  const alt = rec.alternative
  if (alt && !(alt.family === rec.family && alt.effort === rec.effort)) {
    out.push({
      label: alt.why ? `${label(alt.family, alt.effort)} — ${alt.why}` : label(alt.family, alt.effort),
      choice: { family: alt.family, effort: alt.effort },
    })
  }
  const keep = { label: `Keep ${currentLabel(current)} (current)`, choice: null }
  // When the router's answer is to keep the current model, that comes first.
  return rec.family === 'keep' ? [{ ...keep, label: `${keep.label.slice(0, -' (current)'.length)} (Recommended)` }, ...out] : [...out, keep]
}

// Maps the picker's answer to a choice; null keeps the current model.
// Free text under "Other" is read for a family and an effort ("fable max").
// A word after a negation in the same clause doesn't count ("don't use opus",
// "not haiku, sonnet", "opus instead of sonnet"), and an effort on its own
// applies to the recommended model.
const NEGATIONS = new Set(['not', 'no', 'don', 'dont', 'never', 'without', 'instead', 'rather', 'avoid', 'skip', 'except'])

function meantWords(answer: string): string[] {
  const out: string[] = []
  for (const clause of answer.toLowerCase().split(/[,.;:!?()]|\bbut\b/)) {
    let negated = false
    for (const w of clause.split(/[^a-z]+/).filter(Boolean)) {
      if (NEGATIONS.has(w)) negated = true
      else if (!negated) out.push(w)
    }
  }
  return out
}

export function resolveAnswer(answer: string, opts: readonly Option[], rec?: Rec): Choice | 'unrecognized' {
  const exact = opts.find(o => o.label === answer)
  if (exact) return exact.choice
  const meant = meantWords(answer)
  const family = FAMILIES.find(f => meant.includes(f))
  const effort = EFFORTS.find(e => meant.includes(e)) ?? null
  if (family) return { family, effort: effortFor(family, effort) }
  if (meant.includes('keep') || meant.includes('current')) return null
  if (effort && rec && rec.family !== 'keep' && rec.family !== 'haiku') return { family: rec.family, effort }
  return 'unrecognized'
}
