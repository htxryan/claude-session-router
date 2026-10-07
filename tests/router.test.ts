import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { allowedFamilies, currentLabel, defaultEffortOf, isCloseEnough, modelName, options, parseRec, resolveAnswer, restrict } from '../router/pick'
import type { Current } from '../router/pick'

const OPUS_XHIGH: Current = { family: 'opus', model: 'claude-opus-5-5', effort: 'xhigh' }
const USAGE = { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SONNET_PICK = JSON.stringify({
  model: 'sonnet',
  effort: 'medium',
  reason: 'A scoped script change with clear acceptance criteria.',
  confidence: 0.8,
  alternative: { model: 'opus', effort: 'low', why: 'stronger model, similar cost' },
})

type Env = { reply?: string | null; answer?: string; origin?: string; surfaces?: string[]; turns?: number; model?: string; replies?: number; fast?: boolean }

// Stands in for the engine beneath the plugin: the session, the router's
// completion and the picker.
function engine(on: On, env: Env = {}) {
  const calls = { router: 0, asked: [] as string[], options: [] as string[][], skillReads: [] as string[], routerInputs: [] as string[], logs: [] as string[] }
  mock.store(on)
  mock.clock(on)
  const value = <T>(v: T) => ({ value: v }) as never
  on('session.turns', () => value(env.turns ?? 0))
  on('session.messages', () =>
    value(Array.from({ length: env.replies ?? 0 }, () => ({ role: 'assistant', content: [] }))))
  on('session.surfaces', () => value(env.surfaces ?? ['terminal']))
  on('session.model', () => value(env.model ?? 'claude-opus-5-5'))
  on('session.cwd', () => value('/Users/me/src/example-app'))
  on('settings.read', () => value({ effortLevel: 'xhigh', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }))
  on('env.get', () => value(undefined))
  on('fs.read', (_$, e) => {
    calls.skillReads.push(String((e as { path?: unknown }).path))
    return value('---\nname: choose-model\n---\nRouting instructions.')
  })
  on('model.complete', (_$, e) => {
    calls.router += 1
    calls.routerInputs.push(String((e as { prompt?: unknown }).prompt))
    if (env.reply === null) return value({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE })
    return value({ isAnswered: true, text: env.reply ?? SONNET_PICK, usage: USAGE })
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0]!
    calls.asked.push(q.question)
    calls.options.push(q.options.map(o => o.label))
    const answer = env.answer ?? q.options[0]!.label
    return { result: { questions: e.questions, answers: { [q.question]: answer } } } as never
  })
  on('command.register', (_$, e) => value({ command: e.name }))
  on('ui.status', () => value(undefined))
  on('ui.toast', () => value(undefined))
  on('ui.log', (_$, e) => {
    calls.logs.push(String((e as { text?: unknown }).text))
    return value(undefined)
  })
  on('config.list', () => value(env.fast ? [{ key: 'fast', value: true }] : []))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  return calls
}

const submit = ($: any, text: string, origin = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind: origin } })

// What /router reports: the plugin's own read of its routing state.
const routerSays = async ($: any): Promise<string> =>
  (await $.command.run({ command: 'router', args: '', origin: { kind: 'composer' }, presentation: {} })).text ?? ''

describe('pick logic', () => {
  test('reads the router contract and rejects anything else', () => {
    expect(parseRec(SONNET_PICK)?.family).toBe('sonnet')
    expect(parseRec('```json\n' + SONNET_PICK + '\n```')?.effort).toBe('medium')
    expect(parseRec('{"model":"gpt","reason":"x"}')).toBe(null)
    expect(parseRec('not json')).toBe(null)
    expect(parseRec('{"model":"haiku","effort":"high","reason":"quick lookup"}')?.effort).toBe(null)
    expect(parseRec('{"model":"Sonnet","effort":"High","reason":"x"}')).toMatchObject({ family: 'sonnet', effort: 'high' })
    expect(parseRec('{"model":"claude-opus-5-5","effort":"x-high","reason":"x"}')).toMatchObject({ family: 'opus', effort: 'xhigh' })
    expect(parseRec('{"model":"Keep","reason":"x"}')?.family).toBe('keep')
    expect(restrict(parseRec('{"model":"opus","reason":"x"}')!, allowedFamilies('fable, opus, sonnet, haiku')).family).toBe('keep')
  })

  test('close enough means same family within one effort level', () => {
    const rec = parseRec(SONNET_PICK)!
    expect(isCloseEnough(rec, OPUS_XHIGH)).toBe(false)
    expect(isCloseEnough({ ...rec, family: 'opus', effort: 'high' }, OPUS_XHIGH)).toBe(true)
    expect(isCloseEnough({ ...rec, family: 'opus', effort: 'medium' }, OPUS_XHIGH)).toBe(false)
    expect(isCloseEnough({ ...rec, family: 'opus', effort: 'high' }, { ...OPUS_XHIGH, effort: null })).toBe(false)
  })

  test('picker answers map to choices, free text included', () => {
    const opts = options(parseRec(SONNET_PICK)!, OPUS_XHIGH)
    expect(opts.map(o => o.label)).toEqual([
      'Sonnet 5.5 · medium (Recommended)',
      'Opus 5.5 · low — stronger model, similar cost',
      'Keep Opus 5.5 · xhigh (current)',
    ])
    const haikuFirst = options(parseRec('{"model":"haiku","reason":"quick","alternative":{"model":"opus","why":"safer"}}')!, OPUS_XHIGH)
    expect(haikuFirst.map(o => o.label)).toEqual([
      'Haiku 4.5 (Recommended)',
      'Opus 5.5 · medium — safer',
      'Keep Opus 5.5 · xhigh (current)',
    ])
    expect(resolveAnswer(opts[0]!.label, opts)).toEqual({ family: 'sonnet', effort: 'medium' })
    expect(resolveAnswer(opts[2]!.label, opts)).toBe(null)
    expect(resolveAnswer('fable max', opts)).toEqual({ family: 'fable', effort: 'max' })
    expect(resolveAnswer('Haiku please', opts)).toEqual({ family: 'haiku', effort: null })
    expect(resolveAnswer('sonnet', opts)).toEqual({ family: 'sonnet', effort: 'medium' })
    expect(resolveAnswer('whatever', opts)).toBe('unrecognized')
    expect(resolveAnswer('not opus, use sonnet', opts)).toEqual({ family: 'sonnet', effort: 'medium' })
    expect(resolveAnswer("don't use opus, haiku is fine", opts)).toEqual({ family: 'haiku', effort: null })
    expect(resolveAnswer('not haiku, opus high', opts)).toEqual({ family: 'opus', effort: 'high' })
    expect(resolveAnswer('opus instead of sonnet', opts)).toEqual({ family: 'opus', effort: 'medium' })
    expect(resolveAnswer("don't keep it, use haiku", opts)).toEqual({ family: 'haiku', effort: null })
    expect(resolveAnswer("don't switch, keep it", opts)).toBe(null)
    expect(resolveAnswer('low', opts, parseRec(SONNET_PICK)!)).toEqual({ family: 'sonnet', effort: 'low' })
    expect(resolveAnswer('not sure', opts)).toBe('unrecognized')
  })
})

describe('model names', () => {
  test('names any model ID and knows its default effort', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
    expect(modelName('claude-mythos-5-1')).toBe('claude-mythos-5-1')
    expect(defaultEffortOf('claude-opus-5-5')).toBe('medium')
    expect(defaultEffortOf('claude-opus-4-8')).toBe('high')
    expect(defaultEffortOf('claude-opus-4-7')).toBe('xhigh')
    expect(currentLabel({ family: 'opus', model: 'claude-opus-4-8', effort: 'high' })).toBe('Opus 4.8 · high')
    const rec = parseRec('{"model":"opus","effort":"high","reason":"x"}')!
    expect(isCloseEnough(rec, { family: 'opus', model: 'claude-opus-4-8', effort: 'high' })).toBe(false)
  })
})

describe('excluded models', () => {
  const FABLE_PICK = JSON.stringify({
    model: 'fable',
    effort: 'high',
    reason: 'An unattended multi-hour port.',
    alternative: { model: 'opus', effort: 'xhigh', why: 'cheaper, nearly as strong' },
  })

  test('reads the setting and holds the pick to it', () => {
    expect(allowedFamilies('')).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(allowedFamilies('Fable, haiku')).toEqual(['opus', 'sonnet'])
    const rec = restrict(parseRec(FABLE_PICK)!, allowedFamilies('fable'))
    expect(rec.family).toBe('opus')
    expect(rec.effort).toBe('xhigh')
    expect(rec.alternative).toBe(null)
    expect(rec.reason).toMatch(/Fable 5\.1 is excluded in your settings/)
    const noAlt = restrict(parseRec(FABLE_PICK)!, allowedFamilies('fable, opus'))
    expect(noAlt.family).toBe('keep')
    const altDropped = restrict(parseRec(SONNET_PICK)!, allowedFamilies('opus'))
    expect(altDropped.family).toBe('sonnet')
    expect(altDropped.alternative).toBe(null)
  })

  test('the picker never offers an excluded model', { options: { excludeModels: 'fable' } }, async ($, on) => {
    const reply = JSON.stringify({ ...JSON.parse(FABLE_PICK), alternative: { model: 'sonnet', effort: 'high', why: 'faster' } })
    const calls = engine(on, { reply })
    await submit($, 'Port this C library to Rust overnight')
    expect(calls.options[0]).toEqual(['Sonnet 5.5 · high (Recommended)', 'Keep Opus 5.5 · high (current)'])
    expect(calls.asked[0]).toMatch(/Fable 5\.1 is excluded in your settings/)
    expect(calls.routerInputs[0]).toMatch(/"models": \[\s*"opus",\s*"sonnet",\s*"haiku"\s*\]/)
  })
})

describe('routing a session', () => {
  test('routes the first prompt after the person picks, then rewrites main-loop requests', async ($, on) => {
    const calls = engine(on)
    on('turn.step', async function* (_$, e) {
      return { stopReason: 'end_turn', model: e.model, effort: e.effort } as never
    })
    const sent = await submit($, 'Add a --dry-run flag to scripts/sync.py')
    expect(sent.text).toBe('Add a --dry-run flag to scripts/sync.py')
    expect(calls.router).toBe(1)
    expect(calls.skillReads[0]).toMatch(/skills\/choose-model\/SKILL\.md$/)
    expect(calls.asked[0]).toMatch(/Run this session on Sonnet 5\.5 · medium\?$/)
    expect(calls.options[0]).toEqual(['Sonnet 5.5 · medium (Recommended)', 'Opus 5.5 · low — stronger model, similar cost', 'Keep Opus 5.5 · high (current)'])
    expect(await routerSays($)).toMatch(/^Routed to Sonnet 5\.5 · medium\./)
  })

  test('main-loop requests run on the choice; subagent requests keep theirs', async ($, on) => {
    engine(on)
    const seen: { model: string; effort?: unknown; agentId?: string }[] = []
    on('turn.step', async function* (_$, e) {
      seen.push({ model: e.model, effort: e.effort, agentId: e.agentId })
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    await drain({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })
    await drain({ turnId: 't1', index: 1, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' })
    expect(seen[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium', agentId: undefined })
    expect(seen[1]!.model).toBe('claude-haiku-4-5')
  })

  test('only the first prompt routes', async ($, on) => {
    const calls = engine(on, { replies: 3 })
    await submit($, 'next thing')
    expect(calls.router).toBe(0)
  })

  test('never routes once a turn has started, even after a notification-led first turn', async ($, on) => {
    const calls = engine(on)
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    await $.turn.start({ text: '', turnId: 't0' })
    await submit($, 'Add a --dry-run flag')
    expect(calls.router).toBe(0)
    expect(await routerSays($)).toMatch(/^Routing skipped/)
  })

  test('a prompt typed while the first turn runs is not routed', async ($, on) => {
    const calls = engine(on)
    await $.prompt.submit({ text: 'also this', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
    expect(calls.router).toBe(0)
  })

  test('keeping the current model sends the prompt without switching', async ($, on) => {
    engine(on, { answer: 'Keep Opus 5.5 · high (current)' })
    await submit($, 'Add a --dry-run flag')
    expect(await routerSays($)).toMatch(/^Kept the current model/)
  })

  test('a close pick sends without asking', async ($, on) => {
    const calls = engine(on, { reply: JSON.stringify({ model: 'opus', effort: 'high', reason: 'Fits.', confidence: 0.7, alternative: null }) })
    await submit($, 'Design the sync protocol')
    expect(calls.asked.length).toBe(0)
    expect(await routerSays($)).toMatch(/^Kept the current model/)
  })

  test('a router failure falls through to the current model', async ($, on) => {
    const calls = engine(on, { reply: null })
    const sent = await submit($, 'hello')
    expect(sent.text).toBe('hello')
    expect(calls.asked.length).toBe(0)
    expect(await routerSays($)).toMatch(/^Routing skipped/)
  })

  test('headless runs, notifications and peers are never routed', async ($, on) => {
    const calls = engine(on, { surfaces: [] })
    await submit($, 'run the report', 'sdk')
    await submit($, 'task finished', 'task-notification')
    expect(calls.router).toBe(0)
  })

  test('the desktop app (an SDK host with a surface) routes', async ($, on) => {
    const calls = engine(on, { surfaces: ['desktop'] })
    await submit($, 'Add a --dry-run flag', 'sdk')
    expect(calls.router).toBe(1)
  })

  test('the bypass prefix skips routing and is removed', async ($, on) => {
    const calls = engine(on)
    const sent = await submit($, '  ~~ just do it')
    expect(sent.text).toBe('just do it')
    expect(calls.router).toBe(0)
  })

  test('remote auto mode applies the pick without asking', { options: { remoteMode: 'auto' } }, async ($, on) => {
    const calls = engine(on)
    await submit($, 'Add a --dry-run flag', 'bridge')
    expect(calls.asked.length).toBe(0)
    expect(await routerSays($)).toMatch(/^Routed to/)
  })

  test('/clear resets routing so the next first prompt routes again', async ($, on) => {
    const env: Env = {}
    const calls = engine(on, env)
    await submit($, 'Add a --dry-run flag')
    env.turns = 1 // Claude Code keeps counting turns across /clear
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
    env.replies = 0 // /clear empties the conversation
    expect(await routerSays($)).toMatch(/^Not routed yet/)
    await submit($, 'Something else')
    expect(calls.router).toBe(2)
  })

  test("this plugin's own commands are not routed", async ($, on) => {
    const calls = engine(on)
    await submit($, '/session-router:choose-model fix a typo')
    expect(calls.router).toBe(0)
  })

  test('/effort ends only the effort part of the switch; /model ends all of it', async ($, on) => {
    engine(on)
    const seen: { model: string; effort?: unknown }[] = []
    on('turn.step', async function* (_$, e) {
      seen.push({ model: e.model, effort: e.effort })
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    on('command.run', (_$, e) => ({ text: '' }) as never)
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1 }
    await $.command.run({ command: 'effort', args: 'low', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await drain(step)
    expect(seen[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
    expect(await routerSays($)).toMatch(/the model switch still applies/)
    await $.command.run({ command: 'model', args: 'opus', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await drain(step)
    expect(seen[1]).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  })

  test('ask-when-close asks even when the router would keep the current model', { options: { askWhenClose: true } }, async ($, on) => {
    const reply = JSON.stringify({ model: 'keep', effort: null, reason: 'Opus at high already fits.', alternative: { model: 'sonnet', effort: 'medium', why: 'faster' } })
    const calls = engine(on, { reply })
    await submit($, 'Fix the pagination bug')
    expect(calls.options[0]).toEqual(['Keep Opus 5.5 · high (Recommended)', 'Sonnet 5.5 · medium — faster'])
    expect(calls.asked[0]).toMatch(/Keep Opus 5\.5 · high\?$/)
    expect(await routerSays($)).toMatch(/^Kept the current model/)
  })

  test('an older model is named as itself and offered the upgrade', async ($, on) => {
    const reply = JSON.stringify({ model: 'opus', effort: 'high', reason: 'Fits Opus.', alternative: null })
    const calls = engine(on, { reply, model: 'claude-opus-4-8' })
    await submit($, 'Design the sync protocol')
    expect(calls.options[0]).toEqual(['Opus 5.5 · high (Recommended)', 'Keep Opus 4.8 · xhigh (current)'])
  })

  test('local commands and shell commands before the first prompt do not stop routing', async ($, on) => {
    const env: Env = {}
    const calls = engine(on, env)
    env.turns = 2 // /effort adds transcript rows, but the model hasn't replied
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }) as never)
    await $.turn.start({ text: '<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>', turnId: 'sh' })
    env.replies = 1 // the model answered the shell output
    await $.turn.complete({ turnId: 'sh', reason: 'end_turn', text: 'ok', answer: 'ok' } as never)
    await submit($, 'Add a --dry-run flag')
    expect(calls.router).toBe(1)
  })

  test('a resumed session, where the model has already replied, is not routed', async ($, on) => {
    const calls = engine(on, { replies: 3 })
    await submit($, 'Add a --dry-run flag')
    expect(calls.router).toBe(0)
  })

  test('the bypass prefix on its own is sent as typed', async ($, on) => {
    const calls = engine(on)
    const sent = await submit($, '~~')
    expect(sent.text).toBe('~~')
    expect(calls.router).toBe(1)
  })

  test('a top-level effortLevel applies to models before Opus 5.5', async ($, on) => {
    const calls = engine(on, { model: 'claude-fable-5-1' })
    await submit($, 'Add a --dry-run flag')
    expect(calls.options[0]).toContain('Keep Fable 5.1 · xhigh (current)')
  })

  test('with fast mode on, a non-Opus pick says fast mode only applies to Opus', async ($, on) => {
    const calls = engine(on, { fast: true })
    await submit($, 'Add a --dry-run flag')
    expect(calls.asked[0]).toMatch(/Fast mode only applies to Opus\.\)$/)
  })

  test('says so when another model answered the first routed turn', async ($, on) => {
    const calls = engine(on)
    on('turn.complete', () => ({ text: '' }) as never)
    await submit($, 'Add a --dry-run flag')
    const done = { turnId: 't1', reason: 'end_turn', text: 'ok', answer: 'ok' }
    await $.turn.complete({ ...done, usage: { model: 'claude-opus-4-8' } } as never)
    await $.turn.complete({ ...done, usage: { model: 'claude-opus-4-8' } } as never)
    expect(calls.logs.filter(n => n.includes('but claude-opus-4-8 answered')).length).toBe(1)
  })
})
