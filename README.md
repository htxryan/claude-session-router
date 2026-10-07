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
- **Settings** (`/plugin` → session-router):
  - **Mode:** `frugal`, `balanced` or `performance`.
  - **Models to never recommend:** for example `fable` if you don't have access.
  - **Router:** its model, effort and timeout.
  - **Remote Control:** `ask` (the default) shows the picker on your phone, `auto` applies the pick without asking, and `skip` leaves phone sessions unrouted.

It only switches the model for this session. It never runs `/model`, so your saved default stays as it is. If the router fails or takes longer than its timeout (30 seconds by default), the prompt is sent on the current model and the notice says so. Headless runs (`claude -p`) are never routed. In Claude Cowork only the skill is expected to work, not the automatic routing.

## Costs and limits

- **One router call per new session.** Opus 5.5 at medium effort reads your first prompt, which takes about 5 seconds and a little of your plan or API credits. Typing your own answer in the picker adds a short low-effort call. Later prompts cost nothing extra.
- **Fable can cost more.** Some plans bill it to usage credits. To never be offered it, add `fable` to the models to never recommend.
- **Subagents and compaction follow the original model.** Subagents that inherit the main model (including Explore) run on the model the session started with, and Claude Code plans compaction for that model's context window. A session routed from 1M-context Opus to Haiku 4.5 (200k) can reach Haiku's limit first.
- **`/effort` saves to the original model** as its default effort.
- **`claude --effort` isn't visible to plugins.** The picker shows your saved effort as current, but the flag still applies if you keep the current model.
- **A wrong type in `pluginConfigs` stops the plugin loading**, and the error only appears in the debug log. Set options through `/plugin` instead of editing `settings.json`.
- **In the picker,** Esc and "Chat about this" keep the current model, and Ctrl+C doesn't close it. Text typed while it's routing stays in the prompt box rather than joining the first prompt.

## Sources

The guidance the skill is built on:

- **Claude docs:** [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) · [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) · [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence) · [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) · Prompting guides for [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) and [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)
- **Claude Code:** [Model configuration](https://code.claude.com/docs/en/model-config) · [Choosing a Claude model and effort level in Claude Code](https://claude.com/blog/claude-model-and-effort-level-in-claude-code) · [Spending your effort](https://claude.dev/blog/spending-your-effort/) · [What a task costs on Opus 5.5](https://claude.dev/blog/what-a-task-costs-on-opus-5-5/) · [Building with Claude Sonnet 5.5](https://claude.dev/blog/building-with-claude-sonnet-5-5/) · [Opus 5.5 and longer coding sessions](https://claude.com/resources/articles/claude-opus-5-5-built-for-coding-sessions-that-use-more-context)
- **Announcements:** [Fable 5.1](https://www.anthropic.com/claude-fable-and-mythos-5-1) · [Opus 5.5](https://www.anthropic.com/claude-opus-5-5) · [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5) · [Haiku 4.5](https://www.anthropic.com/news/claude-haiku-4-5)

---

<p align="center">Made with Claude by <a href="https://ryanhenderson.dev">Ryan Henderson</a></p>
