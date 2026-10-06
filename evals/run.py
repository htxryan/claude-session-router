# /// script
# requires-python = ">=3.11"
# ///
"""Runs the choose-model skill in router mode over evals/probes.json.

Each probe goes through the same call the plugin makes (the skill as the
system prompt, the router input as the one user message, the router model at
its effort), `--runs` times, through `claude -p` on your own login.

Scores per probe and overall:
  valid      the reply is the JSON contract
  accepted   the (model, effort) is in the probe's accept list
  preferred  the model is the probe's preferred one
  stable     share of runs agreeing with the most common (model, effort)

Usage:
  uv run evals/run.py [--runs 5] [--jobs 6] [--only id,id] [--skill PATH] [--probes evals/holdout.json]
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import json
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAMILIES = {"fable", "opus", "sonnet", "haiku"}
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
DEFAULT_EFFORT = {"fable": "high", "opus": "medium", "sonnet": "medium"}


def skill_body(path: pathlib.Path) -> str:
    text = path.read_text()
    if text.startswith("---"):
        text = text.split("---", 2)[2]
    return text.strip()


def router_input(probe: dict, defaults: dict) -> str:
    prompt = probe["prompt"]
    return json.dumps(
        {
            "prompt": prompt,
            "current": probe.get("current", defaults["current"]),
            "project": "src/example-app",
            "signals": {"promptChars": len(prompt), "hasImages": probe.get("hasImages", defaults["hasImages"])},
            "mode": probe.get("mode", defaults["mode"]),
            "preferences": probe.get("preferences", defaults["preferences"]),
        },
        indent=2,
    )


def parse(text: str) -> tuple[str, str | None] | None:
    """Mirrors router/pick.ts parseRec: the pick, effort filled with the family default."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(raw.get("reason"), str) or not raw["reason"].strip():
        return None
    model = raw.get("model")
    if model == "keep":
        return ("keep", None)
    if model not in FAMILIES:
        return None
    if model == "haiku":
        return ("haiku", None)
    effort = raw.get("effort") if raw.get("effort") in EFFORTS else DEFAULT_EFFORT[model]
    return (model, effort)


def call(system: str, user: str, model: str, effort: str) -> tuple[str, float]:
    started = time.monotonic()
    out = subprocess.run(
        [
            "claude", "-p", "--model", model, "--effort", effort,
            "--system-prompt", system, "--tools", "", "--strict-mcp-config",
            "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
            "--no-session-persistence", "--output-format", "json", user,
        ],
        capture_output=True, text=True, timeout=180, cwd="/tmp",
    )
    elapsed = time.monotonic() - started
    try:
        return json.loads(out.stdout).get("result", ""), elapsed
    except json.JSONDecodeError:
        return f"<<no json: {out.stderr[-300:]}>>", elapsed


def fmt(pick: tuple[str, str | None] | None) -> str:
    if pick is None:
        return "INVALID"
    model, effort = pick
    return model if effort is None else f"{model}·{effort}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--only", default="")
    ap.add_argument("--skill", default=str(ROOT / "skills/choose-model/SKILL.md"))
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--effort", default="medium")
    ap.add_argument("--out", default="")
    ap.add_argument("--probes", default=str(ROOT / "evals/probes.json"))
    args = ap.parse_args()

    spec = json.loads(pathlib.Path(args.probes).read_text())
    probes = spec["probes"]
    if args.only:
        wanted = set(args.only.split(","))
        probes = [p for p in probes if p["id"] in wanted]
    system = skill_body(pathlib.Path(args.skill))

    jobs = [(p, i) for p in probes for i in range(args.runs)]
    results: dict[str, list[dict]] = collections.defaultdict(list)
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {
            pool.submit(call, system, router_input(p, spec["defaults"]), args.model, args.effort): p
            for p, _ in jobs
        }
        for done, fut in enumerate(cf.as_completed(futures), 1):
            p = futures[fut]
            text, secs = fut.result()
            results[p["id"]].append({"text": text, "pick": parse(text), "secs": secs})
            print(f"\r{done}/{len(jobs)} calls", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)

    rows, totals = [], collections.Counter()
    for p in probes:
        runs = results[p["id"]]
        picks = [r["pick"] for r in runs]
        accept = {m: set(e) for m, e in p["accept"].items()}
        # "keep" means the current model and effort, so it also counts as that pick.
        cur = p.get("current", spec["defaults"]["current"])
        cur_family = next((f for f in FAMILIES if f in cur["model"]), None)
        as_current = (cur_family, None if cur_family == "haiku" else cur.get("effort"))

        def ok(x):
            if x is None:
                return False
            if x[0] in accept and x[1] in accept[x[0]]:
                return True
            return x[0] == "keep" and as_current[0] in accept and as_current[1] in accept[as_current[0]]

        valid = sum(x is not None for x in picks)
        accepted = sum(ok(x) for x in picks)
        preferred = sum(x is not None and (x[0] == p["prefer"] or (x[0] == "keep" and as_current[0] == p["prefer"])) for x in picks)
        common, n_common = collections.Counter(fmt(x) for x in picks).most_common(1)[0]
        rows.append({
            "id": p["id"], "runs": len(runs), "valid": valid, "accepted": accepted, "preferred": preferred,
            "stable": n_common / len(runs), "modal": common,
            "picks": collections.Counter(fmt(x) for x in picks), "secs": sum(r["secs"] for r in runs) / len(runs),
            "samples": [r["text"] for r in runs[:2]],
        })
        totals.update(runs=len(runs), valid=valid, accepted=accepted, preferred=preferred)

    stable_all = sum(r["stable"] for r in rows) / len(rows)
    lines = [
        f"# choose-model eval: {len(probes)} probes × {args.runs} runs ({args.model} at {args.effort})",
        "",
        f"- valid JSON: {totals['valid']}/{totals['runs']} ({totals['valid'] / totals['runs']:.0%})",
        f"- accepted: {totals['accepted']}/{totals['runs']} ({totals['accepted'] / totals['runs']:.0%})",
        f"- preferred model: {totals['preferred']}/{totals['runs']} ({totals['preferred'] / totals['runs']:.0%})",
        f"- mean stability: {stable_all:.0%}",
        f"- mean latency: {sum(r['secs'] for r in rows) / len(rows):.1f}s",
        "",
        "| probe | accepted | stable | picks |",
        "|---|---|---|---|",
    ]
    for r in rows:
        flag = "" if r["accepted"] == r["runs"] else " ⚠"
        picks = ", ".join(f"{k}×{v}" for k, v in r["picks"].most_common())
        lines.append(f"| {r['id']}{flag} | {r['accepted']}/{r['runs']} | {r['stable']:.0%} | {picks} |")
    report = "\n".join(lines)
    print(report)
    if args.out:
        pathlib.Path(args.out).write_text(report + "\n")
        pathlib.Path(args.out).with_suffix(".json").write_text(
            json.dumps(rows, indent=2, default=lambda o: dict(o) if isinstance(o, collections.Counter) else str(o))
        )
    return 0 if totals["accepted"] == totals["runs"] else 1


if __name__ == "__main__":
    sys.exit(main())
