"""
Run trace — the "case file" for one agent turn (CLAUDE.md Showcase Goal 1).

Every LLM call, tool call, delegated worker and self-check made during a
turn is recorded as a *span*:

    {"id": "a1b2c3d4", "parent": None | "<span id>", "kind": "llm" | "check" |
     "tool" | "worker", "label": "...", "start_ms": <epoch ms>,
     "duration_ms": N, "status": "ok" | "error", "provider": ..., "model": ...,
     "input_tokens": N | None, "output_tokens": N | None, "call_index": N | None,
     "detail": "..." | None}

LLM spans are recorded automatically by llm_client.create_chat_completion,
so callers deep inside eval_checks/scope_guard/bootstrap don't need any
plumbing — they just pass an optional `_trace` label. Tool and worker spans
are recorded explicitly by agent_stream.py.

Where spans go: a per-thread sink (a ContextVar), opened by run_agent_stream
for the length of one turn and drained into `{"type": "trace", "span": ...}`
stream events before each other event it yields. With no sink open (e.g. a
Setup-screen brief call) spans are only logged, never collected. Delegated
workers run in a thread pool, which doesn't inherit the sink, so
orchestrator.run_worker opens its own and returns the spans in its result
for the parent to re-parent under the worker's span.

Every span is also logged (logger "trace", INFO, own handler) so the server
log answers "where did the time go" without the UI.

The sink is set and restored with plain .set() calls rather than token
.reset(): run_agent_stream is a generator, and a client disconnect can close
it from a context where a token reset raises.
"""

import logging
import sys
import time
import uuid
from contextvars import ContextVar

logger = logging.getLogger("run_trace")
if not logger.handlers:
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(logging.Formatter("%(asctime)s trace %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

_sink: ContextVar[list | None] = ContextVar("trace_sink", default=None)


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def now_ms() -> int:
    return int(time.time() * 1000)


def open_sink() -> list | None:
    """Start collecting spans in this thread. Returns the previous sink, to
    hand back to close_sink()."""
    prev = _sink.get()
    _sink.set([])
    return prev


def close_sink(prev: list | None) -> list:
    """Stop collecting, restore the previous sink, return what was left."""
    spans = _sink.get() or []
    _sink.set(prev)
    return spans


def drain() -> list:
    """Spans recorded since the last drain (the sink stays open)."""
    sink = _sink.get()
    if not sink:
        return []
    spans = list(sink)
    sink.clear()
    return spans


def record(kind: str, label: str, start_ms: int, *, status: str = "ok", span_id: str | None = None,
           parent: str | None = None, provider: str | None = None, model: str | None = None,
           input_tokens: int | None = None, output_tokens: int | None = None,
           call_index: int | None = None, detail: str | None = None) -> dict:
    span = {
        "id": span_id or new_id(),
        "parent": parent,
        "kind": kind,
        "label": label,
        "start_ms": start_ms,
        "duration_ms": max(0, now_ms() - start_ms),
        "status": status,
        "provider": provider,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "call_index": call_index,
        "detail": detail,
    }
    sink = _sink.get()
    if sink is not None:
        sink.append(span)
    tokens = f" tokens={input_tokens}/{output_tokens}" if input_tokens is not None else ""
    where = f" {provider}/{model}" if provider else ""
    logger.info("%s %r %dms %s%s%s", kind, label, span["duration_ms"], status, where, tokens)
    return span


def adopt(spans: list, parent: str) -> list:
    """Re-parent a worker's top-level spans under the worker's own span."""
    for s in spans:
        if not s.get("parent"):
            s["parent"] = parent
    return spans


def extend(spans: list) -> None:
    """Add spans recorded elsewhere (a worker's thread) to this thread's sink."""
    sink = _sink.get()
    if sink is not None:
        sink.extend(spans)
