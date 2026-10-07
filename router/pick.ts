// Pure routing logic: what the router sees, how its reply is read, and how
// the person's answer in the picker becomes a choice. No `$` here.

import type { Effort, Family, Choice } from '../types'

const FAMILIES: readonly Family[] = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The latest model of each family, for the per-request rewrite. Update when a
// family gets a new model.
export const LATEST: Record<Family, { id: string; name: string }> = {
  fable: { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  opus: { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  haiku: { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
}

// What each family runs at in Claude Code when nobody names an effort.
const DEFAULT_EFFORT: Record<Exclude<Family, 'haiku'>, Effort> = { fable: 'high', opus: 'medium', sonnet: 'medium' }

const effortFor = (family: Family, effort: Effort | null): Effort | null =>
  family === 'haiku' ? null : (effort ?? DEFAULT_EFFORT[family])

export type Rec = {
  family: Family | 'keep'
  effort: Effort | null
  reason: string
  alternative: { family: Family; effort: Effort | null; why: string } | null
}

export type Current = { family: Family | null; model: string; effort: Effort | null }

export const familyOf = (model: string): Family | null =>
  FAMILIES.find(f => model.toLowerCase().includes(f)) ?? null

// The model ID without a context suffix ("[1m]") or a date stamp.
export const baseId = (model: string): string => model.toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')

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

// Opus 5.5 and later models ignore a top-level effortLevel in user settings.
export const ignoresTopLevelEffort = (model: string): boolean =>
  ['claude-opus-5-5', 'claude-sonnet-5-5'].includes(baseId(model))

// The effort a model runs at in Claude Code when nobody sets one.
export function defaultEffortOf(model: string): Effort | null {
  const family = familyOf(model)
  if (family === 'haiku') return null
  if (family && isLatest(model)) return DEFAULT_EFFORT[family]
  return baseId(model).includes('opus-4-7') ? 'xhigh' : 'high'
}

// An effort level, forgiving about case and punctuation ("High", "x-high").
export const asEffort = (v: unknown): Effort | null => {
  const effort = typeof v === 'string' ? v.toLowerCase().replace(/[^a-z]/g, '') : ''
  return (EFFORTS as readonly string[]).includes(effort) ? (effort as Effort) : null
}

// A family from the router's reply, forgiving about case and full model IDs
// ("Sonnet", "claude-sonnet-5-5").
const asFamily = (v: unknown): Family | null => (typeof v === 'string' ? familyOf(v) : null)

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

// The JSON object in a model's reply, fenced or not.
function readJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

// Reads the router's reply; null when it is not the contract.
export function parseRec(text: string): Rec | null {
  const raw = readJson(text)
  if (!raw) return null
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

// Whether a choice is what the session already runs on.
export const isCurrent = (choice: { family: Family; effort: Effort | null }, current: Current): boolean =>
  isLatest(current.model) && choice.family === current.family && (choice.family === 'haiku' || choice.effort === current.effort)

// The choices in the picker. A pick that is just the current setting (asked
// anyway under askWhenClose) is offered as keeping it.
export function options(rec: Rec, current: Current): Option[] {
  const keeps = rec.family === 'keep' || isCurrent({ family: rec.family, effort: rec.effort }, current)
  const out: Option[] = []
  if (!keeps && rec.family !== 'keep') {
    out.push({ label: `${label(rec.family, rec.effort)} (Recommended)`, choice: { family: rec.family, effort: rec.effort } })
  }
  const alt = rec.alternative
  if (alt && !isCurrent(alt, current) && !(alt.family === rec.family && alt.effort === rec.effort)) {
    out.push({
      label: alt.why ? `${label(alt.family, alt.effort)} — ${alt.why}` : label(alt.family, alt.effort),
      choice: { family: alt.family, effort: alt.effort },
    })
  }
  const keep = `Keep ${currentLabel(current)}`
  // When the answer is to keep the current model, that comes first.
  return keeps ? [{ label: `${keep} (Recommended)`, choice: null }, ...out] : [...out, { label: `${keep} (current)`, choice: null }]
}

// Instructions for reading an answer typed into the picker.
export const ANSWER_SYSTEM = `A person was asked which Claude model a Claude Code session should run on, and typed their own answer instead of picking an option. Decide what they chose.

The input is JSON: their answer, the recommended model and effort, and the session's current model and effort.

Reply with one JSON object and nothing else: {"model": "keep" | "fable" | "opus" | "sonnet" | "haiku" | "unclear", "effort": "low" | "medium" | "high" | "xhigh" | "max" | null}

- "keep": stay on the current model at its current effort, changing nothing (e.g. "keep it", "no change", "current is fine", or naming the current model without a new effort).
- Otherwise the model they ask for, and always an effort for fable, opus and sonnet: the one they ask for ("maximum", "lowest" or "bump it up" map to a level); if they name none, the current effort for the current model, the recommended effort for the recommended model, and otherwise "medium" for opus and sonnet or "high" for fable. Never an effort they turned down.
- An effort alone applies to the recommended model; "keep the model but at high" means the current model at that effort.
- Haiku has no effort: always null.
- Models or efforts they turn down ("not opus", "max isn't needed") are not their choice.
- "unclear" when you can't tell, when they ask for something other than these four latest models (an older version such as "opus 4.8"), or when the answer isn't about choosing a model.`

export function answerInput(answer: string, rec: Rec, current: Current): string {
  return JSON.stringify({
    answer: answer.slice(0, 500),
    recommended: rec.family === 'keep' ? 'keep the current model' : label(rec.family, rec.effort),
    current: currentLabel(current),
  })
}

// A typed answer that is only a model and an effort ("sonnet", "opus high",
// "low"), read without a call; undefined for anything else. Naming the
// current model keeps its effort; an effort alone applies to the
// recommended model.
export function plainAnswer(answer: string, rec: Rec, current: Current): Choice | undefined {
  const words = answer.toLowerCase().trim().split(/\s+/)
  const family = words.length <= 2 ? (FAMILIES.find(f => words[0] === f) ?? null) : null
  const effort = asEffort(family ? (words[1] ?? '') : words.length === 1 ? words[0] : '')
  if (family && (words.length === 1 || effort)) return { family, effort: effortFor(family, effort ?? inheritedEffort(family, rec, current)) }
  if (!family && effort && rec.family !== 'keep' && rec.family !== 'haiku') return { family: rec.family, effort }
  return undefined
}

// The effort for a model named without one: the current effort for the
// current model, the recommended effort for the recommended model.
const inheritedEffort = (family: Family, rec: Rec, current: Current): Effort | null =>
  family === current.family ? current.effort : family === rec.family ? rec.effort : null

// Reads the router model's reading of a typed answer; 'unrecognized' when it
// couldn't tell or the reply isn't the contract.
export function parseAnswer(text: string, rec: Rec, current: Current): Choice | 'unrecognized' {
  const raw = readJson(text)
  if (!raw) return 'unrecognized'
  const effort = asEffort(raw.effort)
  if (String(raw.model).toLowerCase() === 'keep') {
    // "Keep the model, but at high": the current model at that effort.
    const family = current.family
    return effort && family && family !== 'haiku' && isLatest(current.model) ? { family, effort } : null
  }
  const family = asFamily(raw.model)
  return family ? { family, effort: effortFor(family, effort ?? inheritedEffort(family, rec, current)) } : 'unrecognized'
}
