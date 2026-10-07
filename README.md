<p align="center">
  <img src="assets/logo.svg" width="88" height="88" alt="Claude Session Router logo">
</p>
<h1 align="center">Claude Session Router</h1>
<p align="center"><strong>The right Claude model and effort for each session.</strong></p>
<p align="center">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-6e7781?style=flat-square&labelColor=30363d">
  <img alt="Requires Claude Code 2.1.289 or later" src="https://img.shields.io/badge/requires-2.1.289%2B-6e7781?style=flat-square&labelColor=30363d">
  <img alt="Evals: 100% acceptable picks" src="https://img.shields.io/badge/evals-100%25%20acceptable-6e7781?style=flat-square&labelColor=30363d">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6e7781?style=flat-square&labelColor=30363d">
</p>
<p align="center"><a href="#install">Install</a> · <a href="docs/how-it-works.md">How it works</a> · <a href="#sources">Sources</a></p>

<div align="center">
  <video src="https://github.com/user-attachments/assets/c4d93400-3260-4c0f-8cbd-a36927914642" width="720" controls muted playsinline></video>
</div>

Claude Session Router is a Claude Code plugin that picks the model and effort for each new session.

- You send the first prompt of a session, or the first after `/clear`.
- Opus 5.5 reads it and recommends the latest Fable, Opus, Sonnet or Haiku, plus an effort level.
- It tells you why. You confirm or override before the prompt is sent.

Later prompts in the session are never routed.

**Where the recommendations come from:** [one skill](skills/choose-model/SKILL.md) that condenses what Anthropic has published on choosing a model and effort level, current as of October 2026.

- It draws on the model docs, launch announcements and Claude Code guidance listed under [Sources](#sources), and quotes Anthropic directly where it can.
- You can run it yourself: `/session-router:choose-model <task>`.

This is an independent plugin, not an Anthropic product.

## Install

Needs Claude Code 2.1.289 or later.

```
/plugin marketplace add htxryan/claude-session-router
/plugin install session-router@claude-session-router
```

To try it without installing: `claude --plugin-dir path/to/claude-session-router`.

## Use

- **Skip routing for one session:** start the first prompt with `~~`.
- **See what happened:** `/session-router:explain`, or the line the plugin adds under your first prompt.
- **Take over:** picking a model with `/model` ends the switch. Picking an effort with `/effort` ends only the effort part, so the routed model stays. Pressing Esc in either changes nothing.

It only switches the model for this session. It never runs `/model`, so your saved default stays as it is. If the router fails or takes longer than its timeout (30 seconds by default), the prompt is sent on the current model and the notice says so. Headless runs (`claude -p`) are routed only in auto mode. In Claude Cowork only the skill is expected to work, not the automatic routing.

## Settings

Set them in `/plugin` → session-router, or in `~/.claude/settings.json`.

- **Mode:**
  - `default` shows the picker before switching.
  - `shadow` notes what it would pick, without asking or switching.
  - `auto` applies the pick without asking, and routes headless runs (`claude -p`) too.
- **Style:** `frugal`, `balanced` (the default) or `performance`. Styles only break ties between close options: `frugal` favours the cheapest model that will finish the task, `performance` the more capable one.
- **Models to never recommend:** for example `fable` if you don't have access. You can still type one in the picker.
- **Router:** the model and effort that read your first prompt, and how long to wait for them (30 seconds by default).
- **Remote Control:** in default mode, `ask` (the default) shows the picker on your phone, `auto` applies the pick without asking, and `skip` leaves phone sessions unrouted. `skip` also holds in auto mode.
- **Skip prefix:** `~~` by default. Avoid `!`, which starts shell mode, and `/`, which starts commands.
- **Ask if same** (default mode only): off by default, so when the pick is the model and effort you're already on, the prompt is sent without asking. Turn it on to see the picker anyway. Any other pick, even one effort level away, always asks.

The same settings in `settings.json`, with the defaults except for `excludeModels`:

```jsonc
{
  "pluginConfigs": {
    "session-router@claude-session-router": {
      "options": {
        "mode": "default",                  // default | shadow | auto
        "style": "balanced",                // frugal | balanced | performance
        "excludeModels": "fable",           // comma-separated: fable, opus, sonnet, haiku
        "routerModel": "claude-opus-5-5",
        "routerEffort": "medium",           // low | medium | high | xhigh | max
        "timeoutMs": 30000,                 // after this, the prompt goes on the current model
        "remoteMode": "ask",                // ask | auto | skip
        "bypassPrefix": "~~",               // avoid ! (shell mode) and / (commands)
        "askIfSame": false                  // default mode only; true: show the picker even when the pick changes nothing
      }
    }
  }
}
```

## Costs and limits

- **One router call per session:** about 5 seconds and a little of your plan or API credits. A typed answer in the picker adds a short second call.
- **Fable can cost more:** some plans bill it to usage credits. Exclude it in Settings to never be offered it.
- **Subagents and compaction follow the original model.** A session routed from 1M-context Opus to Haiku (200k) can hit Haiku's limit before compacting.
- **`/effort` is saved as the original model's default.**
- **`claude --effort` isn't visible to plugins,** so the picker shows your saved effort as current.
- **A wrong type in `pluginConfigs`** (e.g. `"30000"` for `timeoutMs`) stops the plugin loading, with the error only in the debug log.
- **In the picker,** Esc and "Chat about this" keep the current model, and Ctrl+C doesn't close it.
- **An unknown value for a setting with a fixed list** (e.g. `style: "cheap"`) uses its default, and the first prompt names it.

## What it hooks

The plugin is a mod: TypeScript in [hooks/register.ts](hooks/register.ts) that Claude Code runs on these events. Beyond them it reads your effort settings (`settings.json` and `CLAUDE_CODE_EFFORT_LEVEL`), the session's transcript and its own skill file. The only thing it sends anywhere is the router call to Claude.

- **`prompt.submit`:** on a session's first prompt only, asks the router model for a pick, shows the picker, then sends the prompt on unchanged (minus the skip prefix). Later prompts pass through untouched.
- **`turn.step`:** sets the model and effort on each main-loop request of a routed session. It changes nothing else in the request, and leaves subagents alone.
- **`turn.start` and `turn.complete`:** add the routing notice under the first prompt, and note when another model answered (a fallback).
- **`command.run`:** answers `/session-router:explain`. For `/model` and `/effort` it only notes the newest transcript line, to tell a pick from Esc; the command itself runs unchanged.
- **`classic.SessionStart`:** reads whether the session was resumed or forked, so it isn't routed. It changes nothing.
- **`classic.PostModelSwitch`:** reads whether Claude Code switched the model by itself, which ends the switch. It changes nothing.
- **`session.end`:** clears the plugin's own state for the session.

## Sources

The guidance the skill is built on:

- **Claude docs:** [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) · [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) · [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence) · [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) · Prompting guides for [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) and [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)
- **Claude Code:** [Model configuration](https://code.claude.com/docs/en/model-config) · [Choosing a Claude model and effort level in Claude Code](https://claude.com/blog/claude-model-and-effort-level-in-claude-code) · [Spending your effort](https://claude.dev/blog/spending-your-effort/) · [What a task costs on Opus 5.5](https://claude.dev/blog/what-a-task-costs-on-opus-5-5/) · [Building with Claude Sonnet 5.5](https://claude.dev/blog/building-with-claude-sonnet-5-5/) · [Opus 5.5 and longer coding sessions](https://claude.com/resources/articles/claude-opus-5-5-built-for-coding-sessions-that-use-more-context)
- **Announcements:** [Fable 5.1](https://www.anthropic.com/claude-fable-and-mythos-5-1) · [Opus 5.5](https://www.anthropic.com/claude-opus-5-5) · [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5) · [Haiku 4.5](https://www.anthropic.com/news/claude-haiku-4-5)

---

<p align="center">Made with Claude by <a href="https://ryanhenderson.dev">Ryan Henderson</a></p>
