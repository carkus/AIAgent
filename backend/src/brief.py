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
brief gives them their own paragraph, naming every one selected and its
concrete effect on these focuses, rather than only ever discussing the
keywords. See generate_brief's `behaviors`/`traits` args.

Alongside a brief, the model may offer up to two output "relics" (relic.py)
suited to this commission — e.g. slides to pitch it, a PDF case file, a
diagram of how the work splits. Offered only; nothing is built unless the
user clicks one in Setup, and then relic.py builds it from the case and the
agent on board, not by restating this paragraph.
"""
import json
import logging
from llm_client import create_chat_completion

logger = logging.getLogger(__name__)

# Brief-sourced relics: nothing has been researched yet, so a chart (which
# needs real numbers) isn't offered.
BRIEF_RELIC_KINDS = ("slides", "pdf", "docx", "diagram", "markdown", "json")


def _clip(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _brief_map(raw) -> dict | None:
    """The brief drawn as a flow for Setup's brief graph (BriefGraph.tsx):
    the commission, how the agent understood it, the lines of work it will
    split into, and the result it hands back. Optional: a missing or
    malformed map just means no graph, never a failed brief."""
    if not isinstance(raw, dict):
        return None
    ask = _clip(raw.get("ask"), 200)
    result = _clip(raw.get("result"), 200)
    understood = [_clip(u, 160) for u in raw.get("understood") or [] if isinstance(u, str) and u.strip()][:4]
    work = []
    for item in raw.get("work") or []:
        if isinstance(item, dict) and _clip(item.get("label"), 60):
            work.append({"label": _clip(item.get("label"), 60), "detail": _clip(item.get("detail"), 180)})
        elif isinstance(item, str) and item.strip():
            work.append({"label": _clip(item, 60), "detail": ""})
    work = work[:6]
    if not ask or not result or not work:
        return None
    return {"ask": ask, "understood": understood, "work": work, "result": result}


def _relic_suggestions(raw) -> list[dict]:
    suggestions = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        reason = str(item.get("reason") or "").strip()
        if kind in BRIEF_RELIC_KINDS and reason and all(s["kind"] != kind for s in suggestions):
            suggestions.append({"kind": kind, "reason": reason[:200]})
    return suggestions[:2]

_BRIEF_PROMPT = """You are drafting the short "Brief" shown on an AI agent platform's Setup screen. It tells the user how the agent they're about to commission will interpret the specialties (keywords) they've added, before they actually launch it.

Agent type: {agent_type}
Agent name: {agent_name}
Specialties/keywords: {keywords}
{location_line}Active behaviors: {behaviors}
Active personality traits: {traits}
{prior_qa}
Most of the time, just write the brief directly and confidently — you don't need the user's permission to interpret a reasonable set of specialties. Only when the specialties are genuinely ambiguous, sparse, or pulling in conflicting directions (e.g. a single very broad word with no other context, two contradictory domains, or a location need that isn't clear) should you ask the user ONE short, specific clarifying question instead of guessing — don't ask just because you *could* be more specific.

If Agent type is not "job_search", the agent has no ability to search live job listings or job boards — even when a specialty sounds job-related (e.g. "jobs advertised", "job openings"), describe it as scouting for leads and pointing toward useful sources on that topic, never as finding, searching, or reporting back actual job postings/listings. That capability only exists for a "job_search" agent type.

When writing the brief: third person, THREE short paragraphs separated by a blank line (written as \n\n inside the JSON string, never a raw line break), roughly 8-11 sentences in all. It should read as a considered write-up of this particular agent, not a one-liner.

PARAGRAPH 1, the focuses: your analytical read of the combination, not the list. Open with what these specialties mean TOGETHER that none of them means alone: the intersection they define, the underlying goal they imply, or which one is load-bearing and which ones narrow or qualify it. Then analyse that combination: why it is more useful than covering each specialty separately, where they pull against each other or leave a gap, and one concrete, specific scenario where commissioning this agent would actually pay off (a real situation, not "this could be useful for various purposes"). Do NOT open by naming the keywords one after another, and never name more than two keywords in a single sentence; refer to them through what they combine into (e.g. "solar", "insurance", "farms" becomes "the risk side of putting solar on agricultural land", not "solar, insurance and farms"). If this paragraph would read the same with the keywords shuffled, or a reader could reconstruct it from the keyword list alone, it is a keyword walk: rewrite it.{location_rule}

PARAGRAPH 2, its character: how the selected personality traits and behaviors shape the way it will tackle THESE focuses. Name EVERY active trait and behavior listed above (none may be left out), each tied to a concrete effect on this case: what it will do differently with these specialties because of it (e.g. "Meticulous" means it will flag where the evidence on crop-insurance terms is thin rather than smoothing it over; "Max Delegation" means each focus goes to its own worker agent and the main agent only compares their findings). Where two selections interact or pull against each other (e.g. "Concise" with "Cite Sources"), say how that plays out. Never just list the labels. If both traits and behaviors are "(none)", keep this paragraph to one sentence on the plain, default way it will work.

PARAGRAPH 3, the work: what the agent will actually do and what it will report back with, as 2-3 concrete actions that follow from paragraphs 1 and 2 (not one action per keyword). Vary the wording agent to agent; never fall back on a fixed shape like "Agent {agent_name} will... If commissioned, it will... and report back with..." that would make two briefs read like the same mail-merge with different nouns swapped in.

Not enough to go on (should be RARE): only when the specialties together give you genuinely nothing to analyse (e.g. a single generic word, or terms you cannot place at all) and no single clarifying question would fix it, say so plainly in the brief instead of padding it out (it can be shorter than three paragraphs then, but still cover the selected traits and behaviors): one sentence on what you can infer, one on what is missing for a real read, and what kind of specialty the user could add. Do not use this to dodge a combination that just takes some thought; almost any set of two or more specific specialties has a direction worth stating.

Separately from the ambiguity check above, also assess whether commissioning this agent as specified is likely to go badly, and if so add ONE short, specific warning (a plain sentence, no hedging disclaimer boilerplate). Flag it when you see:
- More than {max_delegations} distinct specialties/topics — the platform delegates one worker per topic with a cap of {max_delegations} per turn, so extras will be dropped or starved rather than covered.
- Specialties spanning clearly unrelated domains (e.g. "tax law" and "vintage motorcycles") — the agent's persona and searches will be diluted rather than focused.
- A specialty that asks the agent to give binding legal, medical, financial, or safety advice as fact rather than to research/summarize the topic.
- A specialty that is only meaningful with a location (e.g. "job openings", "weather", "local events") but no location was given.
This is independent of the question/brief choice above — a warning can accompany either a brief or a question. Omit "warning" (or use null) when nothing is actually wrong; don't invent a warning just to have one.

When you write a brief (not a question), also offer up to two pieces of media the user could take away from this commission before it runs, picked for what would genuinely help THIS case: "slides" (to pitch or present the commission), "pdf" (a polished case file to share), "docx" (an editable case file), "diagram" (how the work splits across the focus topics and any workers), "markdown" (a working brief to keep editing), "json" (one entry per line of inquiry, for tracking). Each reason is one short line naming what it would contain for this case specifically. Offer none ([]) when nothing would really add to the brief.

Respond with ONLY raw JSON, no markdown code fences, no other text, exactly one of:
{{"type": "brief", "text": "...", "warning": "..." or null, "relics": [{{"kind": "...", "reason": "..."}}]}}
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
    Returns {"type": "brief" | "question", "text": "...", "warning": "..." | None,
    "relics": [{"kind", "reason"}, ...]} (relics empty for a question)
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
    # No location at all: say nothing about it, or the model spends a
    # sentence on "with no location specified".
    location_line = f"Location focus: {location}\n" if location else ""
    location_rule = (
        f" A location ({location}) only belongs where it genuinely shapes the work."
        if location else " The agent is not location-bound: never mention location."
    )
    prompt = _BRIEF_PROMPT.format(
        agent_type=agent_type or "general",
        agent_name=agent_name or "Agent",
        keywords=", ".join(keywords) if keywords else "(none yet)",
        location_line=location_line,
        location_rule=location_rule,
        behaviors=", ".join(behaviors) if behaviors else "(none)",
        traits=", ".join(traits) if traits else "(none)",
        location_clause=location_clause,
        prior_qa=prior_qa,
        max_delegations=max_delegations or 3,
    )

    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            # Gemini 3.x thinks by default and counts that against max_tokens
            # (OpenAI-compat API), so a tight cap cut the JSON off mid-brief
            # and Setup fell back to its two-line template with no graph.
            # Ollama/qwen3 has thinking off and stops well under this.
            max_tokens=8000,
            temperature=0.6,
            messages=[{"role": "user", "content": prompt}],
        )
        choice = response.choices[0]
        raw = (choice.message.content or "").strip()
        if choice.finish_reason == "length":
            logger.warning("brief: reply hit max_tokens (%d chars), JSON likely cut off", len(raw))
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        # strict=False: small models put real line breaks inside the text
        # string; strict parsing rejected the whole brief, and Setup showed
        # its two-line template fallback instead.
        data = json.loads(raw, strict=False)
        text = (data.get("text") or "").strip()
        kind = data.get("type") if data.get("type") in ("brief", "question") else "brief"
        warning = (data.get("warning") or "").strip() or None
        if not text:
            return None
        relics = _relic_suggestions(data.get("relics")) if kind == "brief" else []
        return {"type": kind, "text": text, "warning": warning, "relics": relics}
    except Exception as e:
        # Logged so a silent template fallback in production can be traced.
        logger.warning("brief: generation failed (%s): %s", provider or "default", e)
        return None


_MAP_PROMPT = """Below is the brief an AI agent wrote about a commission it is about to take on. Draw that same brief as a flow chart the user sees beside it. Short plain phrases (under ~14 words each), synthesised from the brief, never a copy of the keyword list.

Agent type: {agent_type}
Specialties/keywords: {keywords}

<brief>
{brief}
</brief>

Return:
- "ask": what the user is commissioning, in one line.
- "understood": 2-4 instructions the agent takes from it and holds itself to (its angle, its scope, what its traits and behaviors make it do).
- "work": 2-5 lines of work it will actually split the job into (an angle or a worker each, the split the brief's last paragraph describes), each {{"label": "2-5 word title", "detail": "one line on what that branch digs into"}}.
- "result": the finished thing it hands back, in one line.

Respond with ONLY raw JSON, no markdown code fences, no other text:
{{"ask": "...", "understood": ["..."], "work": [{{"label": "...", "detail": "..."}}], "result": "..."}}
"""


def generate_brief_map(
    brief_text: str,
    keywords: list[str],
    agent_type: str | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> dict | None:
    """Second, separate call after the brief text: turns the finished brief
    into BriefGraph's flow. Split from generate_brief so the text never waits
    on (or dies with) the graph. Returns None on any failure, meaning just
    no graph."""
    brief_text = (brief_text or "").strip()
    if not brief_text:
        return None
    prompt = _MAP_PROMPT.format(
        agent_type=agent_type or "general",
        keywords=", ".join(keywords) if keywords else "(none)",
        brief=brief_text[:4000],
    )
    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=4000,  # headroom for Gemini thinking, as above
            temperature=0.4,
            messages=[{"role": "user", "content": prompt}],
        )
        choice = response.choices[0]
        raw = (choice.message.content or "").strip()
        if choice.finish_reason == "length":
            logger.warning("brief map: reply hit max_tokens (%d chars)", len(raw))
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        brief_map = _brief_map(json.loads(raw, strict=False))
        if brief_map is None:
            logger.warning("brief map: reply had no usable ask/work/result")
        return brief_map
    except Exception as e:
        logger.warning("brief map: generation failed (%s): %s", provider or "default", e)
        return None
