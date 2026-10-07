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

const asEffort = (v: unknown): Effort | null =>
  typeof v === 'string' && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : null

const asFamily = (v: unknown): Family | null =>
  typeof v === 'string' && (FAMILIES as readonly string[]).includes(v) ? (v as Family) : null

// Every label names an effort, except Haiku's: it has no effort levels.
export const label = (family: Family, effort: Effort | null): string =>
  family === 'haiku' ? LATEST[family].name : `${LATEST[family].name} · ${effort ?? 'default effort'}`

export const currentLabel = (c: Current): string =>
  c.family ? label(c.family, c.effort) : `${c.model} · ${c.effort ?? 'default effort'}`

export function routerInput(args: {
  prompt: string
  current: Current
  cwd: string
  mode: string
  hasImages: boolean
  preferences: readonly string[]
}): string {
  const prompt = args.prompt.length > 8000 ? `${args.prompt.slice(0, 8000)}\n[truncated]` : args.prompt
  return JSON.stringify(
    {
      prompt,
      current: { model: args.current.model, effort: args.current.effort ?? 'unknown' },
      project: args.cwd.split('/').filter(Boolean).slice(-2).join('/'),
      signals: { promptChars: args.prompt.length, hasImages: args.hasImages },
      mode: args.mode,
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
  const family = raw.model === 'keep' ? 'keep' : asFamily(raw.model)
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

const effortGap = (a: Effort | null, b: Effort | null): number | null =>
  a === null || b === null ? null : Math.abs(EFFORTS.indexOf(a) - EFFORTS.indexOf(b))

// True when the pick is close enough to the current setting that asking would
// only nag: same family and effort within one level (or no effort involved).
export function isCloseEnough(rec: Rec, current: Current): boolean {
  if (rec.family === 'keep') return true
  if (rec.family !== current.family) return false
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
  out.push({ label: `Keep ${currentLabel(current)} (current)`, choice: null })
  return out
}

// Maps the picker's answer to a choice; null keeps the current model.
// Free text under "Other" is read for a family and an effort ("fable max").
export function resolveAnswer(answer: string, opts: readonly Option[]): Choice | 'unrecognized' {
  const exact = opts.find(o => o.label === answer)
  if (exact) return exact.choice
  const words = answer.toLowerCase().split(/[^a-z]+/)
  if (words.includes('keep') || words.includes('current')) return null
  const family = FAMILIES.find(f => words.includes(f))
  if (!family) return 'unrecognized'
  return { family, effort: effortFor(family, EFFORTS.find(e => words.includes(e)) ?? null) }
}
