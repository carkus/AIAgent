"""
Offline evaluation harness — runs the same fixed bootstrap cases against
several (provider, model) arms so they can be compared fairly.

Why this exists: bandit.py ranks arms from live eval_log history, but every
arm in that history saw different purposes from different users, so an arm
can look worse just because it drew harder requests. Here every arm gets the
identical inputs, N times each, and is scored by the same checks.

What it reuses (no parallel logic): bootstrap.generate_agent_config_stream
for generation, including its retries and drops, and eval_checks.check_bootstrap
for scoring, via the eval_result events that stream already yields. Cases add
their own deterministic expectations on top (see _case_checks).

Isolation from live data, enforced by patching module attributes in this
process only:
  - eval_log.record        → no-op  (test runs never reach eval_results.json,
                                     so they never feed the bandit)
  - bootstrap_memory.record → no-op (test configs never become few-shot
                                     examples for real users)
  - bootstrap_memory.retrieve_similar → [] unless --fewshot (memory changes
                                     over time, so grounding makes runs
                                     non-repeatable; off by default)

Usage (from the repo root, reads env.json like server.py does):
  python backend/eval_harness.py --models gemini ollama:qwen2.5-coder:7b
  python backend/eval_harness.py --models ollama:qwen2.5-coder:7b ollama:llama3.2:latest \\
      --repeats 3 --judge gemini --cases backend/eval_cases/bootstrap.jsonl

An arm is "provider" or "provider:model" (split at the first colon, so
Ollama tags like qwen2.5-coder:7b survive). Gemini's model is fixed in
llm_client.py, so "gemini:<anything>" is not meaningful.

Writes eval_runs/<timestamp>.jsonl (one row per case × arm × repeat) and
eval_runs/<timestamp>.md (the report), both outside backend/ and gitignored.
"""
import argparse
import json
import os
import statistics
import sys
import time
from collections import defaultdict

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ENV_JSON = os.path.join(_ROOT, "env.json")
if os.path.exists(_ENV_JSON):
    with open(_ENV_JSON) as f:
        for _section in json.load(f).values():
            for k, v in _section.items():
                os.environ.setdefault(k, v)
os.environ.setdefault("DATA_DIR", os.path.join(_ROOT, "data"))

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import agent_spec  # noqa: E402
import bootstrap  # noqa: E402
import bootstrap_memory  # noqa: E402
import eval_checks  # noqa: E402
import eval_log  # noqa: E402

_DEFAULT_CASES = os.path.join(os.path.dirname(__file__), "eval_cases", "bootstrap.jsonl")
_RUNS_DIR = os.path.join(_ROOT, "eval_runs")


# ── usage capture ─────────────────────────────────────────────────────────

class _Usage:
    """Per-attempt accumulator for LLM calls, split by phase so judge cost
    isn't counted against the arm being tested."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.calls = {"gen": 0, "judge": 0}
        self.tokens_in = {"gen": 0, "judge": 0}
        self.tokens_out = {"gen": 0, "judge": 0}
        self.seconds = {"gen": 0.0, "judge": 0.0}


_usage = _Usage()


def _add_usage(phase, usage):
    if usage is not None:
        _usage.tokens_in[phase] += getattr(usage, "prompt_tokens", 0) or 0
        _usage.tokens_out[phase] += getattr(usage, "completion_tokens", 0) or 0


def _counting(phase, fn):
    """Wraps create_chat_completion to record calls, wall time and tokens.

    Bootstrap's first call streams, and a streamed response only reports
    usage when asked (stream_options.include_usage), in a final chunk with
    no choices that bootstrap's own loop already skips. Timing for a stream
    runs until it's fully consumed, not just until the first byte. If a
    provider rejects stream_options, the call is retried without it, so the
    harness's bookkeeping can never be the reason a run fails."""
    def timed_stream(stream, started):
        try:
            for chunk in stream:
                _add_usage(phase, getattr(chunk, "usage", None))
                yield chunk
        finally:
            _usage.seconds[phase] += time.perf_counter() - started

    def wrapped(*args, **kwargs):
        started = time.perf_counter()
        _usage.calls[phase] += 1
        streaming = kwargs.get("stream") is True
        try:
            if streaming:
                try:
                    response = fn(*args, stream_options={"include_usage": True}, **kwargs)
                except Exception as e:
                    if "stream_options" not in str(e):
                        raise
                    response = fn(*args, **kwargs)
                return timed_stream(response, started)
            response = fn(*args, **kwargs)
        except Exception:
            _usage.seconds[phase] += time.perf_counter() - started
            raise
        _usage.seconds[phase] += time.perf_counter() - started
        _add_usage(phase, getattr(response, "usage", None))
        return response
    return wrapped


def _install_patches(fewshot: bool, judge_arm: tuple[str, str | None] | None):
    eval_log.record = lambda result: None
    bootstrap_memory.record = lambda *a, **k: None
    if not fewshot:
        bootstrap_memory.retrieve_similar = lambda *a, **k: []

    # Both modules did `from llm_client import create_chat_completion`, so
    # each holds its own reference — patch both, tagged by phase.
    bootstrap.create_chat_completion = _counting("gen", bootstrap.create_chat_completion)
    eval_checks.create_chat_completion = _counting("judge", eval_checks.create_chat_completion)

    if judge_arm is not None:
        # Production judges with the agent's own model, which tends to grade
        # its own family leniently. A fixed judge makes arms comparable.
        original_judge = eval_checks._judge
        judge_provider, judge_model = judge_arm
        eval_checks._judge = lambda _p, _m, prompt: original_judge(judge_provider, judge_model, prompt)


# ── cases ─────────────────────────────────────────────────────────────────

def _load_cases(path: str) -> list[dict]:
    cases = []
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            case = json.loads(line)
            if not case.get("id") or not case.get("purpose"):
                raise ValueError(f"{path}:{line_no}: every case needs an id and a purpose")
            cases.append(case)
    return cases


def _tool_labels(config: dict) -> list[str]:
    labels = []
    for t in config.get("tools") or []:
        if isinstance(t, dict):
            labels.append((t.get("name") or "").lower())
            if t.get("mcp_tool"):
                labels.append(t["mcp_tool"].lower())
    return labels


def _case_checks(case: dict, config: dict) -> list[dict]:
    """Deterministic, case-specific expectations from the case's `expect`
    block. Same result shape as eval_checks, prefixed "case:"."""
    expect = case.get("expect") or {}
    tools = [t for t in (config.get("tools") or []) if isinstance(t, dict)]
    labels = _tool_labels(config)
    results = []

    def add(name, passed, reason):
        results.append({"check": f"case:{name}", "passed": passed, "reason": reason, "method": "deterministic"})

    if "tools_any" in expect:
        wanted = [w.lower() for w in expect["tools_any"]]
        hit = [w for w in wanted if any(w in label for label in labels)]
        add("tools_any", bool(hit), f"matched {hit}" if hit else f"no tool name contains any of {wanted}")
    if "tools_none" in expect:
        banned = [w.lower() for w in expect["tools_none"]]
        hit = [w for w in banned if any(w in label for label in labels)]
        add("tools_none", not hit, f"forbidden tool present: {hit}" if hit else "no forbidden tools")
    if "mcp_servers" in expect:
        servers = {t.get("mcp_server") for t in tools if t.get("source") == "mcp"}
        missing = [s for s in expect["mcp_servers"] if s not in servers]
        add("mcp_servers", not missing, f"missing MCP servers: {missing}" if missing else f"uses {sorted(servers)}")
    if "min_tools" in expect:
        add("min_tools", len(tools) >= expect["min_tools"], f"{len(tools)} tools (min {expect['min_tools']})")
    if "max_tools" in expect:
        add("max_tools", len(tools) <= expect["max_tools"], f"{len(tools)} tools (max {expect['max_tools']})")
    if expect.get("persona"):
        persona = config.get("persona") or {}
        add("persona", bool(persona.get("name")), "persona present" if persona.get("name") else "persona missing or malformed")
    return results


# ── running ───────────────────────────────────────────────────────────────

def _parse_arm(text: str) -> tuple[str, str | None]:
    provider, _, model = text.partition(":")
    provider = provider.strip().lower()
    if provider not in ("gemini", "ollama"):
        raise argparse.ArgumentTypeError(f"unknown provider in arm {text!r} (use gemini or ollama:<model>)")
    return provider, (model.strip() or None)


def _arm_label(arm: tuple[str, str | None]) -> str:
    return arm[0] if not arm[1] else f"{arm[0]}:{arm[1]}"


def _run_one(case: dict, arm: tuple[str, str | None]) -> dict:
    provider, model = arm
    _usage.reset()
    spec = agent_spec.normalize(case.get("spec"))
    checks, config, error, served_by = [], None, None, None
    started = time.perf_counter()
    try:
        for event in bootstrap.generate_agent_config_stream(
            case["purpose"], provider=provider, model=model,
            agent_type=case.get("agent_type"), spec=spec,
        ):
            kind = event.get("type")
            if kind == "eval_result":
                checks.append({k: event[k] for k in ("check", "passed", "reason", "method")})
            elif kind == "model" and event.get("used"):
                served_by = f"{event['used']['provider']}:{event['used']['model']}"
            elif kind == "error":
                error = event.get("message") or "bootstrap error"
            elif kind == "done":
                config = event.get("config")
    except Exception as e:
        error = f"{type(e).__name__}: {e}"
    elapsed = time.perf_counter() - started

    if config is not None:
        checks.extend(_case_checks(case, config))
    checks.insert(0, {
        "check": "bootstrap_completed", "passed": config is not None and error is None,
        "reason": error or "config produced", "method": "deterministic",
    })

    return {
        "case": case["id"],
        "arm": _arm_label(arm),
        "served_by": served_by,
        "passed_all_deterministic": all(c["passed"] for c in checks if c["method"] == "deterministic"),
        "checks": checks,
        "error": error,
        "seconds_total": round(elapsed, 2),
        "gen": {"calls": _usage.calls["gen"], "tokens_in": _usage.tokens_in["gen"],
                "tokens_out": _usage.tokens_out["gen"], "seconds": round(_usage.seconds["gen"], 2)},
        "judge": {"calls": _usage.calls["judge"], "tokens_in": _usage.tokens_in["judge"],
                  "tokens_out": _usage.tokens_out["judge"], "seconds": round(_usage.seconds["judge"], 2)},
        "tool_names": [t.get("name") for t in (config or {}).get("tools", []) if isinstance(t, dict)],
    }


# ── report ────────────────────────────────────────────────────────────────

def _pct(passed: int, total: int) -> str:
    return "—" if total == 0 else f"{100 * passed / total:.0f}% ({passed}/{total})"


def _report(rows: list[dict], arms: list[str], meta: dict) -> str:
    by_arm = defaultdict(list)
    for r in rows:
        by_arm[r["arm"]].append(r)

    check_names = []
    for r in rows:
        for c in r["checks"]:
            if c["check"] not in check_names:
                check_names.append(c["check"])

    lines = [
        f"# Bootstrap eval — {meta['started']}",
        "",
        f"Cases: {meta['case_count']} from `{meta['cases_path']}` · repeats: {meta['repeats']} · "
        f"few-shot grounding: {'on' if meta['fewshot'] else 'off'} · "
        f"judge: {meta['judge'] or 'each arm judges itself (production behaviour)'}",
        "",
        "## Pass rate by check",
        "",
        "| check | " + " | ".join(arms) + " |",
        "|---|" + "---|" * len(arms),
    ]
    for name in check_names:
        cells = []
        for arm in arms:
            results = [c for r in by_arm[arm] for c in r["checks"] if c["check"] == name]
            cells.append(_pct(sum(c["passed"] for c in results), len(results)))
        lines.append(f"| {name} | " + " | ".join(cells) + " |")
    cells = [_pct(sum(r["passed_all_deterministic"] for r in by_arm[a]), len(by_arm[a])) for a in arms]
    lines.append("| **all deterministic checks** | " + " | ".join(cells) + " |")

    lines += ["", "## Cost and latency (generation only, judge excluded)", "",
              "| arm | runs | median s | mean LLM calls | mean tokens in | mean tokens out | judge tokens (total) |",
              "|---|---|---|---|---|---|---|"]
    for arm in arms:
        rs = by_arm[arm]
        if not rs:
            continue
        lines.append(
            f"| {arm} | {len(rs)} | {statistics.median(r['seconds_total'] for r in rs):.1f} | "
            f"{statistics.mean(r['gen']['calls'] for r in rs):.1f} | "
            f"{statistics.mean(r['gen']['tokens_in'] for r in rs):.0f} | "
            f"{statistics.mean(r['gen']['tokens_out'] for r in rs):.0f} | "
            f"{sum(r['judge']['tokens_in'] + r['judge']['tokens_out'] for r in rs)} |"
        )

    fallbacks = [r for r in rows if r["served_by"] and not r["served_by"].startswith(r["arm"].split(":")[0])]
    if fallbacks:
        lines += ["", f"**Warning:** {len(fallbacks)} run(s) were served by a different provider than the arm "
                      "requested (cascade fallback), so their scores don't belong to that arm."]

    failures = [(r, c) for r in rows for c in r["checks"] if not c["passed"]]
    if failures:
        lines += ["", "## Failures", "", "| arm | case | check | reason |", "|---|---|---|---|"]
        for r, c in failures:
            reason = (c["reason"] or "").replace("|", "\\|").replace("\n", " ")[:200]
            lines.append(f"| {r['arm']} | {r['case']} | {c['check']} | {reason} |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Run fixed bootstrap cases against several model arms.")
    parser.add_argument("--models", nargs="+", type=_parse_arm, required=True,
                        help="arms to compare: gemini, ollama:<model>")
    parser.add_argument("--cases", default=_DEFAULT_CASES, help="JSONL case file")
    parser.add_argument("--only", nargs="*", help="run only these case ids")
    parser.add_argument("--repeats", type=int, default=2, help="runs per case per arm (outputs vary run to run)")
    parser.add_argument("--judge", type=_parse_arm, default=None,
                        help="fixed judge arm for purpose_fit_judge (default: each arm judges itself)")
    parser.add_argument("--fewshot", action="store_true",
                        help="enable few-shot grounding from live bootstrap memory (less repeatable)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252

    cases = _load_cases(args.cases)
    if args.only:
        cases = [c for c in cases if c["id"] in set(args.only)]
    if not cases:
        sys.exit("no cases to run")

    _install_patches(args.fewshot, args.judge)
    arms = [_arm_label(a) for a in args.models]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    os.makedirs(_RUNS_DIR, exist_ok=True)
    jsonl_path = os.path.join(_RUNS_DIR, f"{stamp}.jsonl")

    total = len(cases) * len(args.models) * args.repeats
    rows, n = [], 0
    with open(jsonl_path, "w", encoding="utf-8") as out:
        for case in cases:
            for arm in args.models:
                for repeat in range(args.repeats):
                    n += 1
                    row = _run_one(case, arm)
                    row["repeat"] = repeat
                    rows.append(row)
                    out.write(json.dumps(row) + "\n")
                    out.flush()
                    status = "ok" if row["passed_all_deterministic"] else "FAIL"
                    print(f"[{n}/{total}] {row['arm']:<28} {case['id']:<24} {status:<4} {row['seconds_total']:>6.1f}s",
                          flush=True)

    report = _report(rows, arms, {
        "started": stamp, "case_count": len(cases), "cases_path": os.path.relpath(args.cases, _ROOT),
        "repeats": args.repeats, "fewshot": args.fewshot,
        "judge": _arm_label(args.judge) if args.judge else None,
    })
    report_path = os.path.join(_RUNS_DIR, f"{stamp}.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)
    print("\n" + report)
    print(f"rows:   {jsonl_path}\nreport: {report_path}")


if __name__ == "__main__":
    main()
