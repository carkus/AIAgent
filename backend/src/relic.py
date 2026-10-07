"""
Builds an output "relic" — a standalone artifact (CSV, diagram, markdown
document, PDF report) made from a finished chat answer — when the user clicks
one of the suggestions the agent attached to that answer (agent_stream.py's
rule 7b / _extract_relic_suggestions).

Advisory and on demand: the agent only suggests, nothing is built unless the
user accepts, and accepting costs one LLM call here (plus at most one
correction retry). Stateless like recap.py: the frontend sends the answer,
the question it answered and any worker findings; nothing is stored, and the
chat history is left untouched.

Returns the relic's text content; the frontend previews it and turns it into
the actual file: .csv/.md/.json as-is, Mermaid rendered to .svg ("diagram")
or .png ("chart"), markdown laid out as a PDF ("pdf") or Word file ("docx"),
and a slide outline built into a .pptx ("slides").
"""
import csv
import io
import json
import re

from llm_client import create_chat_completion

KINDS = ("csv", "diagram", "chart", "markdown", "pdf", "docx", "slides", "json")

_MAX_SOURCE_CHARS = 24000
_MAX_WORKER_CHARS = 6000

_FORMAT_RULES = {
    "csv": (
        "a CSV file. First row is a header. One row per item, one column per "
        "attribute worth comparing. Quote any field containing a comma. Bare "
        "values, units in the header (e.g. `Salary (AUD)`), no markdown."
    ),
    "diagram": (
        "a single Mermaid diagram. Pick the closest fit: `flowchart TD` for a "
        "process or relationship, `mindmap` for a grouped breakdown, `pie` or "
        "`xychart-beta` for numbers (bare numeric values only, units in the "
        "title). Node labels are plain text with no brackets or quotes inside. "
        "Output the Mermaid source only, no fence."
    ),
    "markdown": (
        "a standalone markdown document: a `#` title, a one-paragraph summary, "
        "then sections with `##` headings, tables where data is tabular, and a "
        "short 'Next steps' section. It must read on its own, without the chat."
    ),
    "pdf": (
        "a polished report in markdown (it is rendered to PDF): a `#` title, an "
        "executive summary paragraph, `##` sections for each finding, tables "
        "where data is tabular, and a closing 'Recommendation' section. It must "
        "read on its own, without the chat. No Mermaid or other code blocks."
    ),
    "docx": (
        "an editable report in markdown (it is converted to a Word document): a "
        "`#` title, a summary paragraph, `##` sections for each finding, tables "
        "where data is tabular, and a closing 'Recommendation' section. It must "
        "read on its own, without the chat. No Mermaid or other code blocks."
    ),
    "chart": (
        "a single Mermaid chart of the answer's numbers (it is rendered to a PNG "
        "image). Use `pie` for shares of a whole, otherwise `xychart-beta` with "
        "`x-axis [...]`, `y-axis \"Label (unit)\"` and one `bar` or `line` series. "
        "Bare numeric values only, units in the title or axis label. Output the "
        "Mermaid source only, no fence."
    ),
    "slides": (
        "a short slide deck, as JSON only: {\"title\": str, \"subtitle\": str, "
        "\"slides\": [{\"title\": str, \"bullets\": [str, ...], \"notes\": str}]}. "
        "3 to 10 slides, at most 6 bullets each, each bullet under 15 words; "
        "notes are optional speaker notes. End with a takeaway or next-steps slide."
    ),
    "json": (
        "structured data as JSON only: an array of objects, one per item, with "
        "the same keys on every object (camelCase, values as numbers/booleans "
        "where they are numeric/yes-no). Wrap it in an object only if there is "
        "more than one kind of item."
    ),
}

_PROMPT = """You are {agent_name}. You answered the user in chat, and they asked for that answer as {format_rules}

Purpose of the artifact: {reason}

Build it ONLY from the material below. Do not invent data, sources, or numbers that aren't in it; leave a cell empty rather than guess. Keep the substance, drop chat phrasing ("let me know", follow-up questions).

<question>
{question}
</question>

<answer>
{answer}
</answer>
{workers}
Reply with the artifact content only."""

_DIAGRAM_START_RE = re.compile(
    r"^(flowchart|graph|mindmap|pie|xychart-beta|sequenceDiagram|timeline|quadrantChart)\b",
    re.IGNORECASE,
)
_FENCE_RE = re.compile(r"^```[a-zA-Z-]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


def _strip_fence(text: str) -> str:
    match = _FENCE_RE.match(text.strip())
    return (match.group(1) if match else text).strip()


def _slides_problem(data) -> str | None:
    if not isinstance(data, dict) or not isinstance(data.get("slides"), list):
        return 'It must be an object with a "slides" array.'
    slides = data["slides"]
    if not 3 <= len(slides) <= 10:
        return f"It has {len(slides)} slides; it needs 3 to 10."
    for i, slide in enumerate(slides, 1):
        if not isinstance(slide, dict) or not str(slide.get("title") or "").strip():
            return f"Slide {i} needs a title."
        bullets = slide.get("bullets", [])
        if not isinstance(bullets, list) or not all(isinstance(b, str) for b in bullets):
            return f'Slide {i}: "bullets" must be a list of strings.'
    return None


def _problem(kind: str, content: str) -> str | None:
    """Deterministic check of the generated content; None when it's usable."""
    if not content:
        return "The reply was empty."
    if kind in ("json", "slides"):
        try:
            data = json.loads(content)
        except json.JSONDecodeError as e:
            return f"It isn't valid JSON ({e})."
        if kind == "slides":
            return _slides_problem(data)
        if not data:
            return "The JSON is empty."
        return None
    if kind == "chart" and not _CHART_START_RE.match(content):
        return "It must start with `pie` or `xychart-beta`, with no fence or prose."
    if kind == "csv":
        try:
            rows = [r for r in csv.reader(io.StringIO(content)) if any(c.strip() for c in r)]
        except csv.Error as e:
            return f"It isn't valid CSV ({e})."
        if len(rows) < 2:
            return "It needs a header row plus at least one data row."
        width = len(rows[0])
        if width < 2:
            return "It needs at least two columns."
        ragged = [i + 1 for i, r in enumerate(rows) if len(r) != width]
        if ragged:
            return f"Rows {ragged[:5]} don't have the header's {width} columns; quote fields containing commas."
    if kind == "diagram" and not _DIAGRAM_START_RE.match(content):
        return "It must start with a Mermaid diagram type such as `flowchart TD` or `mindmap`, with no fence or prose."
    return None


def _workers_block(workers: list[dict]) -> str:
    parts = []
    for w in workers or []:
        if not isinstance(w, dict):
            continue
        response = str(w.get("response") or "").strip()
        if not response:
            continue
        name = str(w.get("name") or "worker").strip()
        task = str(w.get("task") or "").strip()
        parts.append(f'<worker name="{name}" task="{task}">\n{response[:_MAX_WORKER_CHARS]}\n</worker>')
    if not parts:
        return ""
    return "\nFindings your delegated workers reported (part of the answer):\n" + "\n".join(parts) + "\n"


def generate_relic(
    kind: str,
    reason: str,
    question: str,
    answer: str,
    workers: list[dict] | None,
    agent_name: str,
    provider: str | None = None,
    model: str | None = None,
) -> tuple[str | None, str | None]:
    """Returns (content, error). Exactly one is None."""
    if kind not in KINDS:
        return None, f"Unknown relic kind: {kind}"
    prompt = _PROMPT.format(
        agent_name=f"Agent {agent_name}" if agent_name else "an AI agent",
        format_rules=_FORMAT_RULES[kind],
        reason=reason or "(none given)",
        question=(question or "(not available)")[:4000],
        answer=(answer or "")[:_MAX_SOURCE_CHARS],
        workers=_workers_block(workers or []),
    )
    messages = [{"role": "user", "content": prompt}]
    # Same one-correction-retry shape as bootstrap's JSON retry: a failed
    # deterministic check gets fed back once, then we give up.
    for attempt in range(2):
        try:
            response = create_chat_completion(
                provider=provider,
                model=model,
                max_tokens=4000,
                temperature=0.2,
                messages=messages,
            )
        except Exception as e:
            return None, f"Could not build the {kind}: {e}"
        raw = response.choices[0].message.content or ""
        content = _strip_fence(raw)
        problem = _problem(kind, content)
        if problem is None:
            if kind in ("json", "slides"):
                content = json.dumps(json.loads(content), indent=2, ensure_ascii=False)
            return content, None
        if attempt == 0:
            messages += [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": f"That can't be used: {problem} Reply with the corrected artifact content only."},
            ]
    return None, f"Could not build a valid {kind}: {problem}"
