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

Writes eval_runs/<suite>-<timestamp>.jsonl (one row per case × arm × repeat)
and eval_runs/<suite>-<timestamp>.md (the report), both outside backend/ and
gitignored. --publish also merges a summary into
frontend/public/eval-scoreboard.json for the in-app Scoreboard.

Chat suite (--suite chat, cases in eval_cases/chat.jsonl): scores one real
chat turn (agent_stream.run_agent_stream + its own eval_result checks + the
case's expectations). Each case has a fixture in eval_cases/chat_fixtures/:
the agent config, bootstrapped once and then frozen, and a tool tape
(eval_replay.py). Record once, then compare arms on replay:
  python backend/eval_harness.py --suite chat --record --models ollama:qwen2.5-coder:7b
  python backend/eval_harness.py --suite chat --models gemini ollama:qwen2.5-coder:7b \\
      --repeats 3 --judge gemini --price gemini=0.30,2.50 --publish
Usage comes from the run-trace spans (run_trace.py), so chat-suite tokens
cover every model call the main agent made. A replayed worker comes off the
tape whole, so its own model calls are not counted against the arm.
"""
import argparse
import copy
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
                # Skip blanks: env.json has the same key in several sections, and an
                # empty one listed first used to win (GEMINI_API_KEY "" -> Ollama fallback).
                if v and not os.environ.get(k):
                    os.environ[k] = v
os.environ.setdefault("DATA_DIR", os.path.join(_ROOT, "data"))

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import agent_spec  # noqa: E402
import bootstrap  # noqa: E402
import bootstrap_memory  # noqa: E402
import eval_checks  # noqa: E402
import eval_log  # noqa: E402
import scope_guard  # noqa: E402
import agent_stream  # noqa: E402
import eval_replay  # noqa: E402

_CASES_DIR = os.path.join(os.path.dirname(__file__), "eval_cases")
_DEFAULT_CASES = {
    "bootstrap": os.path.join(_CASES_DIR, "bootstrap.jsonl"),
    "chat": os.path.join(_CASES_DIR, "chat.jsonl"),
}
# One fixture per chat case: the frozen AgentConfig the turn runs against
# (so arms are compared on the same agent, not on their own bootstraps) and
# the tool tape (eval_replay.py). Committed, since they are the test inputs.
_FIXTURES_DIR = os.path.join(_CASES_DIR, "chat_fixtures")
_RUNS_DIR = os.path.join(_ROOT, "eval_runs")
# --publish writes here; Vite serves frontend/public as-is, so the in-app
# Scoreboard (Scoreboard.tsx) reads it as a static file in dev and prod.
_SCOREBOARD = os.path.join(_ROOT, "frontend", "public", "eval-scoreboard.json")


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
            if streaming and "stream_options" not in kwargs:
                try:
                    response = fn(*args, stream_options={"include_usage": True}, **kwargs)
                except Exception as e:
                    if "stream_options" not in str(e):
                        raise
                    response = fn(*args, **kwargs)
                return timed_stream(response, started)
            if streaming:
                return timed_stream(fn(*args, **kwargs), started)
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
        def fixed(_p, _m, prompt, **kw):
            return original_judge(judge_provider, judge_model, prompt, **kw)
        eval_checks._judge = fixed
        # scope_guard did `from eval_checks import _judge`, so it holds its own reference.
        scope_guard._judge = fixed


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


# ── chat suite ────────────────────────────────────────────────────────────

_tape_ref: dict = {"tape": None}


def _fixture_path(case_id: str) -> str:
    return os.path.join(_FIXTURES_DIR, f"{case_id}.json")


def _load_fixture(case_id: str) -> dict | None:
    path = _fixture_path(case_id)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save_fixture(case_id: str, fixture: dict) -> None:
    os.makedirs(_FIXTURES_DIR, exist_ok=True)
    with open(_fixture_path(case_id), "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=1, ensure_ascii=False)
        f.write("\n")


def _bootstrap_fixture_config(case: dict, arm: tuple[str, str | None]) -> dict | None:
    """The agent a chat case runs against, bootstrapped once by the recording
    arm and then frozen, so every arm answers as the same agent."""
    spec = agent_spec.normalize(case.get("spec"))
    config = None
    for event in bootstrap.generate_agent_config_stream(
        case["purpose"], provider=arm[0], model=arm[1], agent_type=case.get("agent_type"), spec=spec,
    ):
        if event.get("type") == "done":
            config = event["config"]
        elif event.get("type") == "error":
            print(f"  bootstrap failed for {case['id']}: {event.get('message')}", flush=True)
    if config is None:
        return None
    config.pop("bootstrap_trace", None)
    config.pop("bootstrap_report", None)
    config["spec"] = spec
    if case.get("keywords"):
        config["keywords"] = case["keywords"]
    if case.get("location"):
        config["location"] = case["location"]
    if case.get("agent_type"):
        config["template"] = case["agent_type"]
    return config


def _chat_case_checks(case: dict, response: str, tool_calls: list[dict]) -> list[dict]:
    """Deterministic per-case expectations for a chat turn, prefixed "case:"."""
    expect = case.get("expect") or {}
    names = [(tc.get("tool") or "").lower() for tc in tool_calls]
    text = response or ""
    results = []

    def add(name, passed, reason):
        results.append({"check": f"case:{name}", "passed": passed, "reason": reason, "method": "deterministic"})

    if "tools_called_any" in expect:
        wanted = [w.lower() for w in expect["tools_called_any"]]
        hit = [w for w in wanted if any(w in n for n in names)]
        add("tools_called_any", bool(hit), f"called {names}" if hit else f"called {names}, none matching {wanted}")
    if "tools_called_none" in expect:
        banned = [w.lower() for w in expect["tools_called_none"]]
        hit = [w for w in banned if any(w in n for n in names)]
        add("tools_called_none", not hit, f"called forbidden {hit}" if hit else "no forbidden tool called")
    if "min_tool_calls" in expect:
        add("min_tool_calls", len(names) >= expect["min_tool_calls"], f"{len(names)} calls (min {expect['min_tool_calls']})")
    if "max_tool_calls" in expect:
        add("max_tool_calls", len(names) <= expect["max_tool_calls"], f"{len(names)} calls (max {expect['max_tool_calls']})")
    if "delegated_min" in expect:
        n = names.count("delegate_to_worker")
        add("delegated_min", n >= expect["delegated_min"], f"{n} workers (min {expect['delegated_min']})")
    if "response_contains_any" in expect:
        wanted = expect["response_contains_any"]
        hit = [w for w in wanted if w.lower() in text.lower()]
        add("response_contains_any", bool(hit), f"contains {hit}" if hit else f"contains none of {wanted}")
    if expect.get("mermaid"):
        has = "```mermaid" in text
        add("mermaid", has, "has a mermaid diagram" if has else "no mermaid fence in the reply")
    if "max_chars" in expect:
        add("max_chars", len(text) <= expect["max_chars"], f"{len(text)} chars (max {expect['max_chars']})")
    return results


def _usage_from_spans(spans: list[dict]) -> tuple[dict, dict]:
    """Calls/tokens/seconds from the run trace (run_trace.py): "llm" spans
    are the arm's own work, "check" spans are judge calls."""
    def agg(kind):
        ss = [s for s in spans if s.get("kind") == kind]
        return {"calls": len(ss),
                "tokens_in": sum(s.get("input_tokens") or 0 for s in ss),
                "tokens_out": sum(s.get("output_tokens") or 0 for s in ss),
                "seconds": round(sum(s.get("duration_ms") or 0 for s in ss) / 1000, 2)}
    return agg("llm"), agg("check")


def _run_chat_one(case: dict, arm: tuple[str, str | None], fixture: dict, record: bool) -> dict:
    provider, model = arm
    config = copy.deepcopy(fixture["config"])
    config["provider"], config["ollama_model"] = provider, model
    tape = eval_replay.ToolTape(fixture.get("tape"), record)
    _tape_ref["tape"] = tape

    checks, spans, done, error, served_by = [], [], None, None, None
    started = time.perf_counter()
    try:
        for event in agent_stream.run_agent_stream([{"role": "user", "content": case["message"]}], config):
            kind = event.get("type")
            if kind == "trace":
                spans.append(event["span"])
            elif kind == "eval_result":
                checks.append({k: event.get(k) for k in ("check", "passed", "reason", "method")})
            elif kind == "model" and event.get("used") and served_by is None:
                served_by = f"{event['used']['provider']}:{event['used']['model']}"
            elif kind == "error":
                error = event.get("message") or "agent error"
            elif kind == "done":
                done = event
    except Exception as e:
        error = f"{type(e).__name__}: {e}"
    elapsed = time.perf_counter() - started
    if record:
        fixture["tape"] = tape.entries

    # A tool error caused by the tape not covering a call (eval_replay "miss")
    # is a gap in the recording, not the arm's mistake: report it, don't score it.
    for c in checks:
        if c.get("check") == "tool_execution_error" and "eval replay:" in (c.get("reason") or ""):
            c["check"], c["method"] = "replay_miss (not scored)", "replay"

    response = (done or {}).get("response") or ""
    tool_calls = (done or {}).get("tool_calls") or []
    if done is not None:
        checks.extend(_chat_case_checks(case, response, tool_calls))
    checks.insert(0, {
        "check": "turn_completed", "passed": done is not None and error is None,
        "reason": error or "reply produced", "method": "deterministic",
    })
    if served_by is None:
        llm = next((s for s in spans if s.get("kind") == "llm" and s.get("status") == "ok"), None)
        if llm:
            served_by = f"{llm.get('provider')}:{llm.get('model')}"
    gen, judge = _usage_from_spans(spans)
    return {
        "case": case["id"],
        "arm": _arm_label(arm),
        "served_by": served_by,
        "passed_all_deterministic": all(c["passed"] for c in checks if c["method"] == "deterministic"),
        "checks": checks,
        "error": error,
        "seconds_total": round(elapsed, 2),
        "gen": gen,
        "judge": judge,
        "replay": dict(tape.stats),
        "tool_names": [tc.get("tool") for tc in tool_calls],
        "response_preview": response[:300],
    }


# ── report ────────────────────────────────────────────────────────────────

def _pct(passed: int, total: int) -> str:
    return "—" if total == 0 else f"{100 * passed / total:.0f}% ({passed}/{total})"


def _is_fallback(row: dict) -> bool:
    return bool(row["served_by"]) and not row["served_by"].startswith(row["arm"].split(":")[0])


def _cost(row: dict, prices: dict) -> float | None:
    """Generation cost in USD from per-1M-token prices. Ollama is local, so 0;
    a provider with no --price is unknown (None), never guessed."""
    provider = row["arm"].split(":")[0]
    if provider == "ollama":
        return 0.0
    if provider not in prices:
        return None
    p_in, p_out = prices[provider]
    return (row["gen"]["tokens_in"] * p_in + row["gen"]["tokens_out"] * p_out) / 1_000_000


def _report(rows: list[dict], arms: list[str], meta: dict) -> str:
    by_arm = defaultdict(list)
    for r in rows:
        by_arm[r["arm"]].append(r)

    check_names = []
    for r in rows:
        for c in r["checks"]:
            if c["check"] not in check_names:
                check_names.append(c["check"])

    title = "Bootstrap eval" if meta["suite"] == "bootstrap" else "Chat-turn eval"
    lines = [
        f"# {title} — {meta['started']}",
        "",
        f"Cases: {meta['case_count']} from `{meta['cases_path']}` · repeats: {meta['repeats']} · "
        f"few-shot grounding: {'on' if meta['fewshot'] else 'off'} · "
        f"judge: {meta['judge'] or 'each arm judges itself (production behaviour)'}"
        + (f" · tools: {'recorded live' if meta.get('record') else 'replayed from tape'}"
           if meta["suite"] == "chat" else ""),
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
              "| arm | runs | median s | mean LLM calls | mean tokens in | mean tokens out | cost/task | judge tokens (total) |",
              "|---|---|---|---|---|---|---|---|"]
    for arm in arms:
        rs = by_arm[arm]
        if not rs:
            continue
        costs = [_cost(r, meta.get("prices") or {}) for r in rs]
        cost = "—" if None in costs else f"${statistics.mean(costs):.4f}"
        lines.append(
            f"| {arm} | {len(rs)} | {statistics.median(r['seconds_total'] for r in rs):.1f} | "
            f"{statistics.mean(r['gen']['calls'] for r in rs):.1f} | "
            f"{statistics.mean(r['gen']['tokens_in'] for r in rs):.0f} | "
            f"{statistics.mean(r['gen']['tokens_out'] for r in rs):.0f} | {cost} | "
            f"{sum(r['judge']['tokens_in'] + r['judge']['tokens_out'] for r in rs)} |"
        )

    if meta["suite"] == "chat":
        lines += ["", "## Tool replay", "",
                  "How each tool call was answered. *fuzzy* = same tool, differently-phrased inputs, "
                  "answered with the recorded result; *miss* = a tool nobody recorded, answered with an error.", "",
                  "| arm | exact | fuzzy | miss | live |", "|---|---|---|---|---|"]
        for arm in arms:
            tot = defaultdict(int)
            for r in by_arm[arm]:
                for k, v in (r.get("replay") or {}).items():
                    tot[k] += v
            lines.append(f"| {arm} | {tot['exact']} | {tot['fuzzy']} | {tot['miss']} | {tot['live']} |")

    fallbacks = [r for r in rows if _is_fallback(r)]
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


# ── scoreboard ────────────────────────────────────────────────────────────

def _scoreboard_suite(rows: list[dict], arms: list[str], meta: dict) -> dict:
    """The per-suite summary the in-app Scoreboard renders. Aggregates only:
    no response text or tool results, since this file is served publicly."""
    out_arms = []
    for arm in arms:
        rs = [r for r in rows if r["arm"] == arm]
        if not rs:
            continue
        checks: dict = {}
        for r in rs:
            for c in r["checks"]:
                if c.get("method") == "replay":
                    continue  # tape coverage, already in "replay"; not a score
                slot = checks.setdefault(c["check"], {"passed": 0, "total": 0})
                slot["total"] += 1
                slot["passed"] += 1 if c["passed"] else 0
        costs = [_cost(r, meta.get("prices") or {}) for r in rs]
        replay = defaultdict(int)
        for r in rs:
            for k, v in (r.get("replay") or {}).items():
                replay[k] += v
        provider, _, model = arm.partition(":")
        out_arms.append({
            "arm": arm,
            "provider": provider,
            "model": model or None,
            "runs": len(rs),
            "pass_all": {"passed": sum(r["passed_all_deterministic"] for r in rs), "total": len(rs)},
            "checks": checks,
            "median_seconds": round(statistics.median(r["seconds_total"] for r in rs), 1),
            "mean_tokens_in": round(statistics.mean(r["gen"]["tokens_in"] for r in rs)),
            "mean_tokens_out": round(statistics.mean(r["gen"]["tokens_out"] for r in rs)),
            "cost_per_task": None if None in costs else round(statistics.mean(costs), 6),
            "fallback_runs": sum(_is_fallback(r) for r in rs),
            "replay": dict(replay) if meta["suite"] == "chat" else None,
        })
    return {
        "generated_at": meta["started"],
        "cases": meta["case_count"],
        "repeats": meta["repeats"],
        "judge": meta["judge"],
        "arms": out_arms,
    }


def _publish(suite: str, summary: dict) -> None:
    """Merge one suite into the scoreboard file, keeping the other suite's
    last published result."""
    board = {"suites": {}}
    if os.path.exists(_SCOREBOARD):
        try:
            with open(_SCOREBOARD, encoding="utf-8") as f:
                board = json.load(f)
        except Exception:
            pass
    board.setdefault("suites", {})[suite] = summary
    board["updated"] = summary["generated_at"]
    os.makedirs(os.path.dirname(_SCOREBOARD), exist_ok=True)
    with open(_SCOREBOARD, "w", encoding="utf-8") as f:
        json.dump(board, f, indent=1)
        f.write("\n")


def _parse_price(text: str) -> tuple[str, tuple[float, float]]:
    provider, _, nums = text.partition("=")
    try:
        p_in, p_out = (float(x) for x in nums.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError(f"--price wants provider=IN,OUT (USD per 1M tokens), got {text!r}")
    return provider.strip().lower(), (p_in, p_out)


def main():
    parser = argparse.ArgumentParser(description="Run fixed eval cases against several model arms.")
    parser.add_argument("--suite", choices=("bootstrap", "chat"), default="bootstrap",
                        help="bootstrap: score generated configs; chat: score one chat turn on a frozen agent")
    parser.add_argument("--models", nargs="+", type=_parse_arm, required=True,
                        help="arms to compare: gemini, ollama:<model>")
    parser.add_argument("--cases", default=None, help="JSONL case file (default: eval_cases/<suite>.jsonl)")
    parser.add_argument("--only", nargs="*", help="run only these case ids")
    parser.add_argument("--repeats", type=int, default=2, help="runs per case per arm (outputs vary run to run)")
    parser.add_argument("--judge", type=_parse_arm, default=None,
                        help="fixed judge arm for LLM-judged checks (default: each arm judges itself)")
    parser.add_argument("--fewshot", action="store_true",
                        help="enable few-shot grounding from live bootstrap memory (less repeatable)")
    parser.add_argument("--record", action="store_true",
                        help="chat suite: run tools live and (re)write each case's fixture; one arm, one repeat")
    parser.add_argument("--price", nargs="*", type=_parse_price, default=[],
                        help="generation price per provider, USD per 1M tokens: gemini=IN,OUT")
    parser.add_argument("--publish", action="store_true",
                        help=f"write the summary to {os.path.relpath(_SCOREBOARD, _ROOT)} for the in-app Scoreboard")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252

    cases_path = args.cases or _DEFAULT_CASES[args.suite]
    cases = _load_cases(cases_path)
    if args.only:
        cases = [c for c in cases if c["id"] in set(args.only)]
    if not cases:
        sys.exit("no cases to run")
    if args.suite == "chat":
        missing = [c["id"] for c in cases if not c.get("message")]
        if missing:
            sys.exit(f"chat cases need a message: {missing}")
    if args.record:
        if args.suite != "chat":
            sys.exit("--record only applies to --suite chat")
        if len(args.models) != 1:
            sys.exit("--record takes exactly one arm (the tape and agent are recorded once, then shared)")
        args.repeats = 1

    _install_patches(args.fewshot, args.judge)
    if args.suite == "chat":
        eval_replay.install(_tape_ref)
    arms = [_arm_label(a) for a in args.models]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    os.makedirs(_RUNS_DIR, exist_ok=True)
    jsonl_path = os.path.join(_RUNS_DIR, f"{args.suite}-{stamp}.jsonl")

    total = len(cases) * len(args.models) * args.repeats
    rows, n = [], 0
    with open(jsonl_path, "w", encoding="utf-8") as out:
        for case in cases:
            fixture = None
            if args.suite == "chat":
                fixture = _load_fixture(case["id"])
                if args.record:
                    if fixture is None:
                        print(f"  bootstrapping the frozen agent for {case['id']}…", flush=True)
                        config = _bootstrap_fixture_config(case, args.models[0])
                        fixture = {"config": config, "tape": []} if config else None
                    else:
                        fixture["tape"] = []  # re-record against the same agent
            for arm in args.models:
                for repeat in range(args.repeats):
                    n += 1
                    if args.suite == "bootstrap":
                        row = _run_one(case, arm)
                    elif fixture is None:
                        reason = ("no fixture — run with --record first" if not args.record
                                  else "could not bootstrap the agent for this case")
                        row = {"case": case["id"], "arm": _arm_label(arm), "served_by": None,
                               "passed_all_deterministic": False,
                               "checks": [{"check": "turn_completed", "passed": False, "reason": reason,
                                           "method": "deterministic"}],
                               "error": reason, "seconds_total": 0.0,
                               "gen": {"calls": 0, "tokens_in": 0, "tokens_out": 0, "seconds": 0},
                               "judge": {"calls": 0, "tokens_in": 0, "tokens_out": 0, "seconds": 0},
                               "replay": {}, "tool_names": []}
                    else:
                        row = _run_chat_one(case, arm, fixture, args.record)
                    row["repeat"] = repeat
                    rows.append(row)
                    out.write(json.dumps(row) + "\n")
                    out.flush()
                    status = "ok" if row["passed_all_deterministic"] else "FAIL"
                    print(f"[{n}/{total}] {row['arm']:<28} {case['id']:<24} {status:<4} {row['seconds_total']:>6.1f}s",
                          flush=True)
            if args.record and fixture is not None:
                fixture["recorded_with"] = _arm_label(args.models[0])
                fixture["recorded_at"] = stamp
                _save_fixture(case["id"], fixture)
                print(f"  saved fixture {os.path.relpath(_fixture_path(case['id']), _ROOT)} "
                      f"({len(fixture['tape'])} tape entries)", flush=True)

    meta = {
        "suite": args.suite, "started": stamp, "case_count": len(cases),
        "cases_path": os.path.relpath(cases_path, _ROOT), "repeats": args.repeats,
        "fewshot": args.fewshot, "judge": _arm_label(args.judge) if args.judge else None,
        "record": args.record, "prices": dict(args.price),
    }
    report = _report(rows, arms, meta)
    report_path = os.path.join(_RUNS_DIR, f"{args.suite}-{stamp}.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)
    print("\n" + report)
    print(f"rows:   {jsonl_path}\nreport: {report_path}")
    if args.publish:
        if args.record:
            print("not publishing a --record run (tools ran live, so it isn't a replayed result)")
        else:
            _publish(args.suite, _scoreboard_suite(rows, arms, meta))
            print(f"published: {_SCOREBOARD}")


if __name__ == "__main__":
    main()
