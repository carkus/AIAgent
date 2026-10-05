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
"""
from llm_client import create_chat_completion

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
- Close on where things stand and one concrete next move.

HARD LIMIT: 3-4 sentences, under 80 words. Plain prose. No markdown, headings, bullet points, or tool names in snake_case. Do not state your own name. Reply with the recap text only."""


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


def generate_recap(
    messages: list[dict],
    system_prompt: str,
    agent_name: str,
    provider: str | None = None,
    model: str | None = None,
) -> str | None:
    transcript = _transcript(messages)
    if not transcript:
        return None
    prompt = _RECAP_PROMPT.format(
        agent_name=f"Agent {agent_name}" if agent_name else "the agent",
        system_prompt=(system_prompt or "(none)").strip(),
        transcript=transcript,
    )
    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=200,
            temperature=0.7,
            messages=[{"role": "user", "content": prompt}],
        )
        text = (response.choices[0].message.content or "").strip()
        return text or None
    except Exception:
        return None
