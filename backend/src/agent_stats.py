"""
Per-published-agent success/failure aggregation over eval_log.json — the
"agent stable" tracking the user asked for: rather than fine-tuning/training
a model (see root CLAUDE.md's TensorFlow discussion), this reuses the
existing eval_checks.py/eval_log.py history, now that mcp_server.py tags
every check a published agent produces with its own agent_id (see
mcp_server.py's _run_once/call_tool and agent_stream.py's run_agent_stream).

Mirrors bandit.py's arm_stats shape exactly, keyed by agent_id instead of
(provider, model) — deliberately a separate module rather than a refactor of
bandit.py, since the two serve different callers (bandit.py picks a
provider/model to use next; this module just describes an already-published
agent's track record for display). No UCB1/exploration-bonus scoring here:
this is descriptive history, not a selection policy choosing between agents.
"""
import eval_log


def stats_for_agents(agent_ids: list[str]) -> dict[str, dict]:
    """{agent_id: {"pulls", "successes", "rate"}} for exactly the given
    agent ids. An agent with no recorded checks yet (never invoked over MCP,
    or invoked before this attribution existed) still appears, with
    pulls=0/successes=0/rate=None, so a cold-start agent is visible to
    callers rather than silently absent."""
    stats = {aid: {"pulls": 0, "successes": 0, "rate": None} for aid in agent_ids}
    for entry in eval_log.list_all():
        aid = entry.get("agent_id")
        if aid not in stats:
            continue
        stats[aid]["pulls"] += 1
        if entry.get("passed"):
            stats[aid]["successes"] += 1
    for s in stats.values():
        if s["pulls"] > 0:
            s["rate"] = s["successes"] / s["pulls"]
    return stats


def recent_entries_for_agent(agent_id: str, limit: int = 50) -> list[dict]:
    """Newest-first eval_log entries recorded for one published agent —
    same ordering convention as eval_log.list_recent()."""
    matches = [e for e in eval_log.list_all() if e.get("agent_id") == agent_id]
    return matches[-limit:][::-1]
