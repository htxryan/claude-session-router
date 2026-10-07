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
  <video src="https://github.com/user-attachments/assets/903c5b66-5239-4210-baf1-638957a03dc2" width="720" controls muted playsinline></video>
</div>

Claude Session Router is a Claude Code plugin that picks the model and effort for each new session. When you send the first prompt of a session (or the first after `/clear`), Opus 5.5 reads it and recommends the latest Fable, Opus, Sonnet or Haiku and an effort level. It tells you why, and you confirm or override before the prompt is sent. Later prompts are never routed.

The recommendations come from [one skill](skills/choose-model/SKILL.md) that condenses what Anthropic has published on choosing a model and effort level, current as of October 2026: the model docs, launch announcements and Claude Code guidance listed under [Sources](#sources). Where it can, the skill quotes Anthropic directly. You can also run it yourself: `/session-router:choose-model <task>`. This is an independent plugin, not an Anthropic product.

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
- **Settings** (`/plugin` → session-router): mode `frugal` / `balanced` / `performance`, models to never recommend (e.g. `fable` if you don't have access), router model and effort, and phone (Remote Control) behaviour.

It only switches the model for this session. It never runs `/model`, so your saved default stays as it is. Headless runs (`claude -p`) are never routed. In Claude Cowork only the skill is expected to work, not the automatic routing.

## Costs and limits

- **One router call per new session.** Before your first prompt is sent, Opus 5.5 at medium effort reads it. That adds a few seconds (about 5 on average) and uses a little of your plan or API credits. If you type your own answer in the picker instead of choosing an option, a second short call at low effort reads it. Later prompts cost nothing extra.
- **Fable can cost more.** On some plans, Fable usage is billed to usage credits. If you'd rather never be offered it, add `fable` to the models to never recommend.

[How it works](docs/how-it-works.md) · [Tests and evals](docs/how-it-works.md#tests)

## Sources

The guidance the skill is built on:

- **Claude docs:** [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) · [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) · [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence) · [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) · Prompting guides for [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) and [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)
- **Claude Code:** [Model configuration](https://code.claude.com/docs/en/model-config) · [Choosing a Claude model and effort level in Claude Code](https://claude.com/blog/claude-model-and-effort-level-in-claude-code) · [Spending your effort](https://claude.dev/blog/spending-your-effort/) · [What a task costs on Opus 5.5](https://claude.dev/blog/what-a-task-costs-on-opus-5-5/) · [Building with Claude Sonnet 5.5](https://claude.dev/blog/building-with-claude-sonnet-5-5/) · [Opus 5.5 and longer coding sessions](https://claude.com/resources/articles/claude-opus-5-5-built-for-coding-sessions-that-use-more-context)
- **Announcements:** [Fable 5.1](https://www.anthropic.com/claude-fable-and-mythos-5-1) · [Opus 5.5](https://www.anthropic.com/claude-opus-5-5) · [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5) · [Haiku 4.5](https://www.anthropic.com/news/claude-haiku-4-5)

---

<p align="center">Made with ❤️ by <a href="https://ryanhenderson.dev">Ryan Henderson</a></p>
