"""
UCB1 multi-armed bandit over (provider, model) arms, using eval_checks.py's
recorded pass/fail results (eval_log.json) as the reward signal. This is the
selection-logic half of the reinforcement-learning gap noted in root
CLAUDE.md: eval_checks.py already tags every recorded check with the
provider/model that produced the thing being graded; this module is what
actually turns that attributable history into a pick.

Each recorded eval_checks entry (one bootstrap check, one chat-response
check, one tool-call check, ...) with a non-null provider/model counts as
one pull of that arm, and its `passed` boolean is the reward (1 or 0). This
is coarser than "one pull per full agent turn" — a single turn emits several
checks, so a chatty turn contributes more samples for whichever arm ran it —
but it needs no new instrumentation beyond what eval_checks.py already
records, and reflects a real granular signal (this exact tool call's inputs
matched its schema, this exact response was judged relevant) rather than an
averaged-away per-turn verdict.

UCB1 (Auer, Cesa-Bianchi & Fischer, 2002):
    score(arm) = mean_reward(arm) + sqrt(2 * ln(total_pulls) / pulls(arm))
An arm with zero recorded pulls gets an infinite score (must-explore) rather
than being skipped or scored as "worst" — the standard UCB1 cold-start rule,
and the only way a newly added model or provider ever gets tried at all
instead of being permanently starved by an early leader.

This module only *recommends* — it never overrides the user's own Setup
screen choice, consistent with this app's human-in-the-loop pattern for
every other consequential automated decision (MCP tool selection, agent
publishing both require an explicit user step). `/models` surfaces the
recommendation as data for the frontend to badge; the provider/model
dropdowns remain fully manual.
"""
import math

import eval_log


def _arm_key(provider: str | None, model: str | None) -> tuple[str, str]:
    return (provider or "", model or "")


def arm_stats(candidates: list[tuple[str, str]]) -> dict[tuple[str, str], dict]:
    """{(provider, model): {"pulls", "successes", "rate"}} for exactly the
    given candidate arms. An arm with no matching recorded entries still
    appears, with pulls=0/successes=0/rate=None, so a cold-start arm is
    visible to callers rather than silently absent."""
    wanted = {_arm_key(p, m) for p, m in candidates}
    stats = {key: {"pulls": 0, "successes": 0, "rate": None} for key in wanted}
    for entry in eval_log.list_all():
        key = _arm_key(entry.get("provider"), entry.get("model"))
        if key not in wanted:
            continue
        stats[key]["pulls"] += 1
        if entry.get("passed"):
            stats[key]["successes"] += 1
    for s in stats.values():
        if s["pulls"] > 0:
            s["rate"] = s["successes"] / s["pulls"]
    return stats


def recommend(candidates: list[tuple[str, str]]) -> dict:
    """Ranks `candidates` (a list of (provider, model) pairs — the arms
    actually available right now, e.g. Gemini plus whatever's pulled in the
    local Ollama install) by UCB1 score computed from eval_log history.

    Returns {"recommended": {"provider", "model"} | None, "arms": [...]},
    each arm dict carrying pulls/successes/rate/score, ranked best-first.
    `recommended` is None only when `candidates` is empty (e.g. no provider
    is currently configured/reachable at all)."""
    if not candidates:
        return {"recommended": None, "arms": []}

    stats = arm_stats(candidates)
    total_pulls = sum(s["pulls"] for s in stats.values())
    log_total = math.log(total_pulls) if total_pulls > 0 else 0.0

    ranked = []
    for provider, model in candidates:
        s = stats[_arm_key(provider, model)]
        if s["pulls"] == 0:
            score = math.inf
        else:
            score = s["rate"] + math.sqrt(2 * log_total / s["pulls"])
        ranked.append({
            "provider": provider,
            "model": model,
            "pulls": s["pulls"],
            "successes": s["successes"],
            "rate": s["rate"],
            "score": score,
        })
    ranked.sort(key=lambda a: a["score"], reverse=True)
    top = ranked[0]
    for a in ranked:
        a["score"] = None if math.isinf(a["score"]) else a["score"]
    return {
        "recommended": {"provider": top["provider"], "model": top["model"]},
        "arms": ranked,
    }
