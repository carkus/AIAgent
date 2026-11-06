"""
Generates the "Previously…" recap shown when a saved chat is resumed
(frontend AgentBriefingModal.tsx). A fresh agent gets its bootstrap-written
`intro` as a mission briefing; a resumed one gets this instead — the agent
itself, in character, telling the story so far and where things stand.

Stateless like brief.py: the frontend sends the saved history + AgentConfig,
nothing is stored. Returns None on any failure so the frontend can fall back
to the plain briefing rather than showing an error.

The recap must synthesize, not transcribe: it should read as the agent's own
account of what the conversation was driving at and what's left open, not a
turn-by-turn list of what was said.

Alongside the recap the agent proposes a few directions to take next: real,
distinct moves grounded in the conversation, which the modal shows as
buttons that send the chosen one as the user's next message.
"""
import json
import logging

from llm_client import create_chat_completion

logger = logging.getLogger(__name__)

# Keep the prompt bounded — a long chat's full history isn't needed to tell
# the story, and the tail is where "where we left off" lives.
_MAX_MESSAGES = 30
_MAX_CHARS_PER_MESSAGE = 1200

_RECAP_PROMPT = """You are {agent_name}, an AI agent. Your persona and standing orders:
---
{system_prompt}
---

The user is reopening an earlier conversation with you. Below is that conversation (most recent turns; long messages are trimmed).

{transcript}

Write a short "Previously…" recap to greet them with — the opening of a new chapter in a story you're both in, told in your own voice, in character, first person. Your persona's personality should come through in the wording.
- Open with one scene-setting line.
- Tell what the two of you were really after and what it came down to. Keep only the one or two findings that matter; drop the rest. Never walk through the conversation turn by turn or restate details in order.
- Close on where things stand.

HARD LIMIT for the recap: 3-4 sentences, under 80 words. Plain prose. No markdown, headings, bullet points, or tool names in snake_case. Do not state your own name.

Then propose 3 or 4 directions the user could take from here, as your own judgement of what would be most worth doing next. Each one:
- is an instruction the user could send you as-is, written as the user speaking to you (e.g. "Compare the two strongest sources on the succession question"), under 14 words;
- comes from what the conversation actually found or left open: dig deeper into a finding, chase an open question, take a new angle, or turn the findings into something (a table, a chart, a report);
- is clearly different from the others. Never "continue", "keep going" or "pick up where we left off".
{focus_line}
Reply with JSON only, no code fence:
{{"recap": "<the recap>", "directions": ["<direction>", "<direction>", "<direction>"]}}"""


def _transcript(messages: list[dict]) -> str:
    lines = []
    for m in messages[-_MAX_MESSAGES:]:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("displayContent") or m.get("content") or ""
        if not isinstance(content, str):
            continue
        content = content.strip()
        if not content:
            continue
        if len(content) > _MAX_CHARS_PER_MESSAGE:
            content = content[:_MAX_CHARS_PER_MESSAGE] + " …"
        lines.append(f"{'User' if role == 'user' else 'You'}: {content}")
    return "\n\n".join(lines)


_MAX_DIRECTIONS = 4
_MAX_DIRECTION_CHARS = 140
_STALL_WORDS = ("continue", "keep going", "pick up where", "carry on")


def _directions(raw) -> list[str]:
    """Cleaned, de-duplicated directions; drops "continue"-style non-moves."""
    out: list[str] = []
    if not isinstance(raw, list):
        return out
    for d in raw:
        if not isinstance(d, str):
            continue
        d = " ".join(d.split()).strip().strip('"').strip()
        if not d or len(d) > _MAX_DIRECTION_CHARS:
            continue
        low = d.lower()
        if any(low.startswith(w) for w in _STALL_WORDS):
            continue
        if low in (o.lower() for o in out):
            continue
        out.append(d)
        if len(out) == _MAX_DIRECTIONS:
            break
    return out


def generate_recap(
    messages: list[dict],
    system_prompt: str,
    agent_name: str,
    provider: str | None = None,
    model: str | None = None,
    keywords: list[str] | None = None,
) -> dict | None:
    """{"text": recap, "directions": [...]} or None on failure. A reply that
    isn't valid JSON is kept as the recap text with no directions."""
    transcript = _transcript(messages)
    if not transcript:
        return None
    topics = [k.strip() for k in (keywords or []) if isinstance(k, str) and k.strip()]
    prompt = _RECAP_PROMPT.format(
        agent_name=f"Agent {agent_name}" if agent_name else "the agent",
        system_prompt=(system_prompt or "(none)").strip(),
        transcript=transcript,
        focus_line=(f"- The job's focus topics are: {', '.join(topics)}. Directions may draw on any of them.\n"
                    if topics else ""),
    )
    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            # Gemini 3.x counts thinking against max_tokens (see brief.py).
            max_tokens=4000,
            temperature=0.7,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = (response.choices[0].message.content or "").strip()
    except Exception:
        return None
    if not raw:
        return None
    body = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(body, strict=False)
    except ValueError:
        logger.info("recap: reply wasn't JSON, using it as the recap text")
        return {"text": raw, "directions": []}
    if not isinstance(data, dict):
        return {"text": raw, "directions": []}
    text = (data.get("recap") or data.get("text") or "").strip()
    if not text:
        return None
    return {"text": text, "directions": _directions(data.get("directions"))}
