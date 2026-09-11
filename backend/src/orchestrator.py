"""
First scaffold of multi-agent orchestration (CLAUDE.md roadmap item 1).

The pattern: a worker IS an agent, built exactly the way any agent is —
via bootstrap.generate_agent_config — just from a narrower purpose (the
subtask string) instead of the user's original purpose. No separate
"worker" schema or code path; the main agent's `delegate_to_worker` tool
call is the only new surface.

Scope of this first pass, deliberately kept small:
- One level deep only. Workers are bootstrapped with allow_delegation=False
  (see agent_stream.run_agent_stream), so they can't spawn their own
  sub-workers — no recursive swarms yet.
- Synchronous / one-shot. The caller sees the worker's *final* result, not
  its own tool-by-tool progress live — that granularity is the natural next
  increment once this pattern proves out.
- A hard per-request delegation cap (see agent_stream.MAX_DELEGATIONS_PER_REQUEST)
  bounds cost: each delegation is a full extra bootstrap call plus its own
  agent loop, so an unbounded main agent could otherwise fan out unboundedly.
"""
from bootstrap import generate_agent_config


def run_worker(task: str, context: str, provider: str | None, model: str | None) -> dict:
    """
    Bootstrap and run one worker agent to completion for `task`.

    Returns a plain dict (JSON-serialized as the delegate_to_worker tool
    result, same as any other tool) so the parent agent — and the person
    reading tool activity in the UI — can see who was spun up, what traits
    it was given, and what it found:
      {"worker_name", "worker_traits", "task", "response", "tools_used"}
    """
    # Deferred import: agent_stream imports this module (lazily, only when
    # delegate_to_worker is actually called) to build _DELEGATE_TOOL's
    # handler, so importing it back at module load time here would be a
    # circular import. Importing inside the function breaks the cycle.
    from agent_stream import run_agent_stream

    try:
        # is_worker=True buckets this bootstrap separately in bootstrap_memory
        # (CLAUDE.md RAG priority 5) — a narrow delegated subtask and a
        # top-level user purpose aren't good few-shot matches for each other,
        # but a worker IS an agent bootstrapped the normal way, so it benefits
        # from the same grounding (few-shot retrieval + the MCP tool catalog)
        # with zero extra code path.
        worker_config = generate_agent_config(purpose=task, provider=provider, model=model, is_worker=True)
    except Exception as e:
        return {
            "worker_name": "Worker",
            "worker_traits": [],
            "task": task,
            "response": f"Could not assemble a worker for this subtask: {e}",
            "tools_used": [],
        }

    persona = worker_config.get("persona") or {}
    user_content = task if not context else f"{task}\n\nContext:\n{context}"

    final_response = ""
    tool_calls: list[dict] = []
    try:
        for event in run_agent_stream(
            [{"role": "user", "content": user_content}],
            worker_config,
            allow_delegation=False,
        ):
            if event["type"] == "done":
                final_response = event["response"]
                tool_calls = event["tool_calls"]
            elif event["type"] == "error":
                final_response = f"Worker failed: {event['message']}"
    except Exception as e:
        final_response = f"Worker crashed: {e}"

    return {
        "worker_name": persona.get("name", "Worker"),
        "worker_traits": persona.get("traits", []),
        "task": task,
        "response": final_response,
        "tools_used": [tc["tool"] for tc in tool_calls],
    }
