import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ANSWER_SYSTEM, allowedFamilies, currentLabel, defaultEffortOf, isCloseEnough, modelName, options, parseAnswer, parseRec, plainAnswer, restrict } from '../router/pick'
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

type Env = { reading?: string; reply?: string | null; answer?: string; origin?: string; surfaces?: string[]; turns?: number; model?: string; replies?: number; fast?: boolean; rows?: string[]; whileAsking?: ($: any) => Promise<void> }

// Stands in for the engine beneath the plugin: the session, the router's
// completion and the picker.
function engine(on: On, env: Env = {}) {
  const calls = { router: 0, asked: [] as string[], options: [] as string[][], skillReads: [] as string[], routerInputs: [] as string[], logs: [] as string[], readings: [] as string[] }
  mock.store(on)
  mock.clock(on)
  const value = <T>(v: T) => ({ value: v }) as never
  on('session.turns', () => value(env.turns ?? 0))
  on('session.messages', (_$, e) =>
    (e as { as?: string }).as === 'api'
      ? value(Array.from({ length: env.replies ?? 0 }, () => ({ role: 'assistant', content: [] })))
      : value((env.rows ?? []).map(text => ({ role: 'user', text, toolUses: [] }))))
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
    if ((e as { system?: unknown }).system === ANSWER_SYSTEM) {
      calls.readings.push(String((e as { prompt?: unknown }).prompt))
      if (env.reading === undefined) throw new Error('unavailable')
      return value({ isAnswered: true, text: env.reading, usage: USAGE })
    }
    calls.router += 1
    calls.routerInputs.push(String((e as { prompt?: unknown }).prompt))
    if (env.reply === 'reject') throw new Error('model claude-nope is not available')
    if (env.reply === null) return value({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE })
    return value({ isAnswered: true, text: env.reply ?? SONNET_PICK, usage: USAGE })
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    await env.whileAsking?.($)
    const q = e.questions[0]!
    calls.asked.push(q.question)
    calls.options.push(q.options.map(o => o.label))
    const answer = env.answer ?? q.options[0]!.label
    return { result: { questions: e.questions, answers: { [q.question]: answer } } } as never
  })
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

// What /session-router:router reports: the plugin's own read of its routing state.
const routerSays = async ($: any): Promise<string> =>
  (await $.command.run({ command: 'session-router:router', args: '', origin: { kind: 'composer' }, presentation: {} })).text ?? ''

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
    const sonnetHigh = parseRec('{"model":"sonnet","effort":"high","reason":"x"}')!
    const read = (model: string, effort: string | null = null) => parseAnswer(JSON.stringify({ model, effort }), sonnetHigh, OPUS_XHIGH)
    expect(read('keep')).toBe(null)
    expect(read('fable', 'max')).toEqual({ family: 'fable', effort: 'max' })
    expect(read('haiku', 'high')).toEqual({ family: 'haiku', effort: null })
    expect(read('sonnet')).toEqual({ family: 'sonnet', effort: 'high' }) // the recommended effort
    expect(read('keep', 'high')).toEqual({ family: 'opus', effort: 'high' })
    expect(read('Opus', 'x-high')).toEqual({ family: 'opus', effort: 'xhigh' })
    expect(read('unclear')).toBe('unrecognized')
    expect(parseAnswer('not json', sonnetHigh, OPUS_XHIGH)).toBe('unrecognized')
    expect(plainAnswer('sonnet', sonnetHigh, OPUS_XHIGH)).toEqual({ family: 'sonnet', effort: 'high' })
    expect(read('opus')).toEqual({ family: 'opus', effort: 'xhigh' }) // the current effort
    const rec = parseRec(SONNET_PICK)!
    expect(plainAnswer('sonnet', rec, OPUS_XHIGH)).toEqual({ family: 'sonnet', effort: 'medium' })
    expect(plainAnswer('Opus high', rec, OPUS_XHIGH)).toEqual({ family: 'opus', effort: 'high' })
    expect(plainAnswer('opus', rec, OPUS_XHIGH)).toEqual({ family: 'opus', effort: 'xhigh' })
    expect(plainAnswer('low', rec, OPUS_XHIGH)).toEqual({ family: 'sonnet', effort: 'low' })
    expect(plainAnswer('haiku', rec, OPUS_XHIGH)).toEqual({ family: 'haiku', effort: null })
    expect(plainAnswer('not opus', rec, OPUS_XHIGH)).toBe(undefined)
    expect(plainAnswer('opus please', rec, OPUS_XHIGH)).toBe(undefined)
  })

  test('a pick that is the current setting is offered as keeping it', () => {
    const same = options(parseRec('{"model":"opus","effort":"xhigh","reason":"x","alternative":{"model":"opus","effort":"xhigh"}}')!, OPUS_XHIGH)
    expect(same.map(o => o.label)).toEqual(['Keep Opus 5.5 · xhigh (Recommended)'])
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

  test('changing the effort ends only the effort part of the switch; changing the model ends all of it', async ($, on) => {
    const env: Env = {}
    engine(on, env)
    const seen: { model: string; effort?: unknown }[] = []
    on('turn.step', async function* (_$, e) {
      seen.push({ model: e.model, effort: e.effort })
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }
    await drain(step)
    expect(seen.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    await drain({ ...step, effort: 'low' }) // /effort low
    expect(seen.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
    expect(await routerSays($)).toMatch(/the model switch still applies/)
    await drain({ ...step, model: 'claude-haiku-4-5', effort: 'low' }) // a fallback for one request goes as it is
    expect(seen.at(-1)!.model).toBe('claude-haiku-4-5')
    await drain({ ...step, effort: 'low' })
    expect(seen.at(-1)!.model).toBe('claude-sonnet-5-5')
    env.model = 'claude-opus-4-8'
    await drain({ ...step, model: 'claude-opus-4-8', effort: 'low' }) // /model
    expect(seen.at(-1)).toEqual({ model: 'claude-opus-4-8', effort: 'low' })
    await drain({ ...step, model: 'claude-opus-4-8', effort: 'low' })
    expect(seen.at(-1)!.model).toBe('claude-opus-4-8')
    expect(await routerSays($)).toMatch(/switch has ended/)
  })

  test('opening /model and pressing Esc keeps the switch; picking the original model ends it', async ($, on) => {
    const env: Env = { rows: ['Add a --dry-run flag'] }
    engine(on, env)
    const seen: string[] = []
    on('turn.step', async function* (_$, e) {
      seen.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    on('command.run', () => ({ text: '' }) as never)
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await drain(step)
    await run('model')
    env.rows!.push('<local-command-stdout>Kept model as Opus 5.5</local-command-stdout>')
    await drain(step)
    expect(seen.at(-1)).toBe('claude-sonnet-5-5')
    await run('model')
    env.rows!.push('<local-command-stdout>Set model to `Opus 5.5` for this session only</local-command-stdout>')
    await drain(step)
    expect(seen.at(-1)).toBe('claude-opus-5-5')
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
    expect(calls.asked[0]).toMatch(/Fast mode only applies to Opus\. Run this session on Sonnet 5\.5 · medium\?$/)
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

  test('a model picked before the first prompt does not end the switch later', async ($, on) => {
    const env: Env = { rows: [] }
    engine(on, env)
    const seen: string[] = []
    on('turn.step', async function* (_$, e) {
      seen.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    on('command.run', () => ({ text: '' }) as never)
    await $.command.run({ command: 'model', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    env.rows!.push('<local-command-stdout>Set model to `Opus 5.5` for this session only</local-command-stdout>')
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    env.rows!.push('Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }
    await drain(step)
    await drain({ ...step, index: 1 })
    expect(seen).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  })

  test('a router request that is refused skips routing and says why', async ($, on) => {
    const calls = engine(on, { reply: 'reject' })
    const sent = await submit($, 'Add a --dry-run flag')
    expect(sent.text).toBe('Add a --dry-run flag')
    expect(await routerSays($)).toMatch(/^Routing skipped. Router unavailable \(.+\)\.$/)
    expect(calls.asked.length).toBe(0)
  })

  test('/resume of another conversation resets routing', async ($, on) => {
    const calls = engine(on)
    await submit($, 'Add a --dry-run flag')
    await $.session.end({ reason: 'resume', sessionId: 's1' } as never)
    expect(await routerSays($)).toMatch(/^Not routed yet/)
    await submit($, 'Add a --dry-run flag')
    expect(calls.router).toBe(2)
  })

  test('a second first prompt while the first is being routed is not routed', async ($, on) => {
    const calls = engine(on)
    await Promise.all([submit($, 'Add a --dry-run flag'), submit($, 'Something else', 'bridge')])
    expect(calls.router).toBe(1)
  })

  test('ask-when-close does not ask when the only choice is the current setting', { options: { askWhenClose: true } }, async ($, on) => {
    const calls = engine(on, { reply: JSON.stringify({ model: 'opus', effort: 'high', reason: 'Fits.', alternative: null }) })
    await submit($, 'Fix the flaky retry logic')
    expect(calls.asked.length).toBe(0)
    expect(await routerSays($)).toMatch(/^Kept the current model/)
  })

  test('a refused request is retried as Claude Code sends it', async ($, on) => {
    engine(on)
    const seen: string[] = []
    on('turn.step', async function* (_$, e) {
      seen.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: seen.length === 1 ? 'refusal' : 'end_turn', usage: null } as never
    })
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }
    await drain(step)
    await drain(step) // the retry, on the session's own model
    await drain({ ...step, index: 1 })
    expect(seen).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  test('a fallback request keeps the routed effort for later requests', async ($, on) => {
    engine(on)
    const seen: { model: string; effort?: unknown }[] = []
    on('turn.step', async function* (_$, e) {
      seen.push({ model: e.model, effort: e.effort })
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }
    await drain(step)
    await drain({ ...step, index: 1, model: 'claude-haiku-4-5', effort: undefined })
    await drain({ ...step, index: 2 })
    expect(seen.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  test('opening /model again before the first pick was read still ends the switch', async ($, on) => {
    const env: Env = { rows: ['Add a --dry-run flag'] }
    engine(on, env)
    const seen: string[] = []
    on('turn.step', async function* (_$, e) {
      seen.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    on('command.run', () => ({ text: '' }) as never)
    await submit($, 'Add a --dry-run flag to scripts/sync.py')
    const drain = async (e: any) => { const it = $.turn.step(e); for await (const _ of it) {} }
    const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await drain(step)
    await run('model')
    env.rows!.push('<local-command-stdout>Set model to `Opus 5.5` for this session only</local-command-stdout>')
    await run('model')
    env.rows!.push('<local-command-stdout>Kept model as Opus 5.5</local-command-stdout>')
    await drain({ ...step, turnId: 't2' })
    expect(seen.at(-1)).toBe('claude-opus-5-5')
  })

  test('a resumed session is not routed, even with no replies left after compaction', async ($, on) => {
    const calls = engine(on)
    on('classic.SessionStart', (_$, e) => ({}) as never)
    await $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'resume', session_id: 's', transcript_path: '', cwd: '' } as never)
    await submit($, 'Add a --dry-run flag')
    expect(calls.router).toBe(0)
    expect(await routerSays($)).toMatch(/resumed/)
  })

  test('Claude Code switching the model itself ends the switch without blaming the person', async ($, on) => {
    engine(on)
    on('classic.PostModelSwitch', () => ({}) as never)
    await submit($, 'Add a --dry-run flag')
    await $.classic.PostModelSwitch({ hook_event_name: 'PostModelSwitch', source: 'auto', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5' } as never)
    expect(await routerSays($)).toMatch(/Claude Code has since switched the model itself/)
  })

  test('the bypass prefix is removed over Remote Control set to skip', { options: { remoteMode: 'skip' } }, async ($, on) => {
    engine(on)
    const sent = await submit($, '~~ do it', 'bridge')
    expect(sent.text).toBe('do it')
  })

  test('an answer the person typed is read by the router model', async ($, on) => {
    const calls = engine(on, { answer: 'not opus, sonnet but low', reading: '{"model":"sonnet","effort":"low"}' })
    const seen: string[] = []
    on('turn.step', async function* (_$, e) {
      seen.push(`${e.model}:${String(e.effort)}`)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    await submit($, 'Add a --dry-run flag')
    expect(JSON.parse(calls.readings[0]!).answer).toBe('not opus, sonnet but low')
    const it = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)
    for await (const _ of it) {}
    expect(seen).toEqual(['claude-sonnet-5-5:low'])
  })

  test('a typed answer that cannot be read keeps the current model', async ($, on) => {
    const calls = engine(on, { answer: 'hmm' })
    await submit($, 'Add a --dry-run flag')
    expect(calls.readings.length).toBe(1)
    expect(await routerSays($)).toMatch(/^Kept the current model/)
  })

  test('picking an option is not sent to the router model', async ($, on) => {
    const calls = engine(on, { answer: 'Keep Opus 5.5 · high (current)' })
    await submit($, 'Add a --dry-run flag')
    expect(calls.readings.length).toBe(0)
    expect(await routerSays($)).toMatch(/^Kept the current model/)
  })

  test('a pick made after another turn started the session is not applied', async ($, on) => {
    const outer = $ as any
    engine(on, { whileAsking: async () => void (await outer.turn.start({ turnId: 'phone', text: 'from the phone' })) })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
    await submit($, 'Add a --dry-run flag')
    expect(await routerSays($)).toMatch(/already under way/)
  })
})
