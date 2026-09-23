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

Active Behavior toggles and Personality traits (Setup.tsx's BEHAVIOR_TOGGLES
/ PERSONALITY_TRAITS — e.g. "Max Delegation", "Meticulous") change what the
bootstrapped agent will actually do just as much as a specialty does, so the
brief must fold their real effect into the same paragraph rather than only
ever discussing the keywords. See generate_brief's `behaviors`/`traits` args.
"""
import json
from llm_client import create_chat_completion

_BRIEF_PROMPT = """You are drafting the short "Brief" shown on an AI agent platform's Setup screen. It tells the user how the agent they're about to commission will interpret the specialties (keywords) they've added, before they actually launch it.

Agent type: {agent_type}
Agent name: {agent_name}
Specialties/keywords: {keywords}
Location focus: {location}
Active behaviors: {behaviors}
Active personality traits: {traits}
{prior_qa}
Most of the time, just write the brief directly and confidently — you don't need the user's permission to interpret a reasonable set of specialties. Only when the specialties are genuinely ambiguous, sparse, or pulling in conflicting directions (e.g. a single very broad word with no other context, two contradictory domains, or a location need that isn't clear) should you ask the user ONE short, specific clarifying question instead of guessing — don't ask just because you *could* be more specific.

If Agent type is not "job_search", the agent has no ability to search live job listings or job boards — even when a specialty sounds job-related (e.g. "jobs advertised", "job openings"), describe it as scouting for leads and pointing toward useful sources on that topic, never as finding, searching, or reporting back actual job postings/listings. That capability only exists for a "job_search" agent type.

When writing the brief: one tight paragraph, 3-4 sentences, third person. The house style — "Agent {agent_name} will <interpret/act on the topics>{location_clause}. If commissioned, it will <2-3 concrete actions> and report back with <what>." — is a scaffold for the FIRST sentence or two only, not the whole brief; never let those exact clause shapes ("Agent {agent_name} will...", "If commissioned, it will...") become a template you refill every time; vary the wording agent to agent so two briefs never read like the same mail-merge with different nouns swapped in. Actually work out what direction the specialties point in together — the underlying goal they share, or which one is load-bearing if they pull in different directions — and write THAT, not a keyword walk; if the brief would read the same with the keywords shuffled, rewrite it. Then go further than restating the mandate: add real analysis — why this particular combination is useful together, what tension or gap exists between the specialties if any, and at least one concrete, specific scenario or use case where commissioning this agent would actually pay off (a real situation, not "this could be useful for various purposes"). If any behaviors or personality traits are active (not "(none)"), the brief MUST also actually account for them — work their real effect on how the agent will act into the same paragraph (e.g. a "Max Delegation" behavior means it will split the work across worker agents; a "Meticulous" trait means it will flag caveats and uncertainty) rather than only ever discussing the specialties. Do not just tack a trait/behavior's label onto the end as a dangling clause — write the sentence as if that behavior/trait actually governs how the actions in it get carried out.

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
    behaviors: list[str] | None = None,
    traits: list[str] | None = None,
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
        behaviors=", ".join(behaviors) if behaviors else "(none)",
        traits=", ".join(traits) if traits else "(none)",
        location_clause=location_clause,
        prior_qa=prior_qa,
        max_delegations=max_delegations or 6,
    )

    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=420,
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
