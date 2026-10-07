# How it works

## Flow

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant CC as Claude Code
    participant Mod as Claude Session Router
    participant Opus as Opus 5.5 (router)
    You->>CC: First prompt (new session or after /clear)
    CC->>Mod: prompt.submit hook
    Mod->>Mod: A person typed it, no turns yet, nothing routed yet?
    Mod->>Opus: choose-model skill + the prompt, current model, mode
    Opus-->>Mod: { model, effort, reason, alternative }
    alt Already on the pick (same model, within one effort level)
        Mod->>Mod: Keep the current model without asking
    else
        Mod->>You: Picker: Recommended / Alternative / Keep current / Other
        You-->>Mod: Choice (Esc keeps the current model)
    end
    Mod->>CC: next(e): the prompt goes on unchanged
    CC->>Mod: turn.start
    Mod->>You: Notice line under the prompt: what was picked and why
    loop Every main-loop model request this session
        CC->>Mod: turn.step hook
        Mod->>CC: next({ ...e, model, effort })
    end
    Note over Mod,CC: Never runs /model: it would save the pick as your default for every future session
```

## The pieces

| File | What it does |
|---|---|
| [`skills/choose-model/SKILL.md`](../skills/choose-model/SKILL.md) | The routing rules, condensed from Anthropic's docs, model announcements and Claude Code blog posts (sources at the end). The router uses it as its system prompt, and you can run it yourself as `/session-router:choose-model <task>`. |
| [`hooks/register.ts`](../hooks/register.ts) | The hooks: catches the first prompt, calls the router, shows the picker, adds the notice line, rewrites the model and effort on each main-loop request, and answers `/session-router:explain`. |
| [`commands/explain.md`](../commands/explain.md) | Lists `/session-router:explain` under the plugin's name. The hooks answer it directly, so it never reaches the model. |
| [`router/pick.ts`](../router/pick.ts) | Pure logic: the latest model of each family, default efforts, picker labels, parsing the router's JSON, and matching your answer. |
| [`evals/`](../evals) | Prompts with acceptable picks, and a runner that scores the skill. |
| [`tests/`](../tests) | Hook tests run with `claude plugin test`. |

## What the skill recommends

In short, from Anthropic's guidance as of October 2026:

- **Opus 5.5 · medium** by default. Raise the effort to `high` for bug fixes in existing code and edge-case-heavy work. Lower it to `low` for mechanical edits across many files.
- **Sonnet 5.5** for well-scoped work with a clear spec and a way to check the result.
- **Haiku 4.5** for lookups and edits that are obviously right or wrong at a glance, not for writing real code.
- **Fable 5.1** for long unattended runs, problems with no existing pattern, high-stakes root-cause hunts, or when Opus has already failed. Not for back-and-forth work.

Update the model table in the skill and `LATEST` in `router/pick.ts` when new models ship. Haiku 5.5 is announced as coming soon.

## Tests

```sh
claude plugin validate .
claude plugin test .                                      # 46 tests
npx -y -p typescript@5.6 tsc -p . --noEmit                # type check; needs the plugin loaded once (--plugin-dir) for its types
uv run evals/run.py --runs 5                              # 38 prompts
uv run evals/run.py --runs 5 --probes evals/holdout.json  # 20 held-out prompts
```

The evals call the router the way the plugin does, through `claude -p` on your own login, so they use your plan or credits. A run of 38 prompts × 5 takes about 2 minutes with 8 jobs (`--jobs 8`).

Results on 2026-10-06 (Opus 5.5 at medium as the router):

| Set | Valid JSON | Acceptable pick | Same pick on repeat runs |
|---|---|---|---|
| Main, 38 × 5 | 100% | 100% | 98% |
| Held out, 20 × 5 | 100% | 100% | 96% |

"Acceptable" means the pick was in the probe's range. Most probes accept several reasonable answers, for example Opus or Fable at certain efforts. The held-out prompts were written after the skill was tuned. They include sessions that start on Haiku, Sonnet or Fable, explicit model requests, a prompt-injection attempt, and excluded models.
