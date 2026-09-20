"""
Generates the Setup screen's "Brief" text (backend/src/agent_stream.py's own
delegation logic is the runtime counterpart of this — this module runs once,
before bootstrap, to help the user see what their specialty pool will mean).

Previously buildAgentBrief() in Setup.tsx synthesized this deterministically
from a fixed per-agent-type template string. This module replaces that with
a real LLM call so the brief reads as a considered interpretation of the
actual specialties chosen, not a fill-in-the-blank sentence — and, since a
model can tell when a specialty pool is genuinely ambiguous or sparse in a
way a template can't, it may ask the user one clarifying question instead of
guessing. The frontend still keeps the old deterministic buildAgentBrief() as
a same-turn fallback if this call fails, so a network hiccup never leaves the
Brief section blank.

Note: the house-style sentence shape below (_BRIEF_PROMPT) is a scaffold for
structure, not a fill-in-the-blank mold — the model is expected to actually
reason about what direction the chosen specialties collectively point
toward (the underlying goal, or which specialty is load-bearing when they
pull different ways), not just restate each keyword back into the template
slots. If a generated brief ever reads like a keyword list wearing a
sentence, that's a prompt regression, not an acceptable output.
"""
import json
from llm_client import create_chat_completion

_BRIEF_PROMPT = """You are drafting the short "Brief" shown on an AI agent platform's Setup screen. It tells the user how the agent they're about to commission will interpret the specialties (keywords) they've added, before they actually launch it.

Agent type: {agent_type}
Agent name: {agent_name}
Specialties/keywords: {keywords}
Location focus: {location}
{prior_qa}
Most of the time, just write the brief directly and confidently — you don't need the user's permission to interpret a reasonable set of specialties. Only when the specialties are genuinely ambiguous, sparse, or pulling in conflicting directions (e.g. a single very broad word with no other context, two contradictory domains, or a location need that isn't clear) should you ask the user ONE short, specific clarifying question instead of guessing — don't ask just because you *could* be more specific.

When writing the brief: one tight paragraph, 2-3 sentences, third person, in this house style — "Agent {agent_name} reads these specialties as a mandate to <interpret/act on the topics>{location_clause}. If commissioned, it will <2-3 concrete actions> and report back with <what>." Treat that shape as a scaffold, not a mold: actually work out what direction the specialties point in together — the underlying goal they share, or which one is load-bearing if they pull in different directions — and write THAT. Do not just walk the keyword list in order and restate each one into a slot; if the brief would read the same with the keywords shuffled, rewrite it.

Separately from the ambiguity check above, also assess whether commissioning this agent as specified is likely to go badly, and if so add ONE short, specific warning (a plain sentence, no hedging disclaimer boilerplate). Flag it when you see:
- More than {max_delegations} distinct specialties/topics — the platform delegates one worker per topic with a cap of {max_delegations} per turn, so extras will be dropped or starved rather than covered.
- Specialties spanning clearly unrelated domains (e.g. "tax law" and "vintage motorcycles") — the agent's persona and searches will be diluted rather than focused.
- A specialty that asks the agent to give binding legal, medical, financial, or safety advice as fact rather than to research/summarize the topic.
- A specialty that is only meaningful with a location (e.g. "job openings", "weather", "local events") but no location was given.
This is independent of the question/brief choice above — a warning can accompany either a brief or a question. Omit "warning" (or use null) when nothing is actually wrong; don't invent a warning just to have one.

Respond with ONLY raw JSON, no markdown code fences, no other text, exactly one of:
{{"type": "brief", "text": "...", "warning": "..." or null}}
{{"type": "question", "text": "...", "warning": "..." or null}}
"""


def generate_brief(
    agent_type: str | None,
    keywords: list[str],
    location: str,
    agent_name: str,
    provider: str | None = None,
    model: str | None = None,
    prior_question: str | None = None,
    prior_answer: str | None = None,
    max_delegations: int | None = None,
) -> dict | None:
    """
    Returns {"type": "brief" | "question", "text": "...", "warning": "..." | None}
    or None if the call/parse failed — callers should fall back to the
    deterministic template brief on None rather than surfacing an error,
    since this is a nice-to-have polish step, not a required one.
    """
    prior_qa = ""
    if prior_question and prior_answer:
        prior_qa = (
            f'You previously asked: "{prior_question}" — the user answered: '
            f'"{prior_answer}". Use that answer now; write the brief this '
            f'time rather than asking again, unless the answer itself opens '
            f'up a genuinely new, different ambiguity.\n'
        )

    location_clause = f" in {location}" if location else ""
    prompt = _BRIEF_PROMPT.format(
        agent_type=agent_type or "general",
        agent_name=agent_name or "Agent",
        keywords=", ".join(keywords) if keywords else "(none yet)",
        location=location or "(none specified)",
        location_clause=location_clause,
        prior_qa=prior_qa,
        max_delegations=max_delegations or 6,
    )

    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=300,
            temperature=0.6,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = (response.choices[0].message.content or "").strip()
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        data = json.loads(raw)
        text = (data.get("text") or "").strip()
        kind = data.get("type") if data.get("type") in ("brief", "question") else "brief"
        warning = (data.get("warning") or "").strip() or None
        if not text:
            return None
        return {"type": kind, "text": text, "warning": warning}
    except Exception:
        return None
