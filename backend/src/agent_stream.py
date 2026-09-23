import concurrent.futures
import json
import logging
import re
import time
from types import SimpleNamespace
from llm_client import create_chat_completion
from tools import execute_tool, fetch_page, search_jobs, search_image
import eval_checks
import eval_log
import mcp_client

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)

# Confirmed against a real turn (gemini-3.6-flash): the model narrates a plan
# in prose, THEN embeds its actual delegate_to_worker call inside a ```json
# fence mid-message instead of using the structured tool_calls field — e.g.
# "Start by gathering tips...\n\nDelegate this task to a worker.\n\n```json\n
# {\"name\": \"delegate_to_worker\", \"arguments\": {...}}\n```". _FENCE_RE
# above only matches when the fence is the ENTIRE message, so this mixed
# shape falls through every fallback in _extract_text_tool_calls and the raw
# prose+JSON gets shown to the user as the final answer instead of being
# executed. This searches for a fenced JSON object/array ANYWHERE in the
# text, not just as the whole message.
_EMBEDDED_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)

# A distinct fence from the ```mermaid the agent uses inside its own final
# answer (diagram-first output, see the CRITICAL TOOL RULES below) — this one
# is the model's own step-by-step plan for the turn, extracted from its FIRST
# response only and streamed as its own `plan` event so the frontend can show
# it right after the user's message, before the assistant's reply.
_PLAN_FENCE_RE = re.compile(r"```mermaid-plan\s*(.*?)\s*```", re.DOTALL)

# Confirmed against a real turn: a weaker model followed the "sketch your
# plan" instruction but skipped the ```mermaid-plan fence entirely, writing
# `flowchart LR Start --> ...` as bare text at the very start of its
# response, immediately followed by its (also unfenced) tool-call JSON. Catch
# that shape too — the fence is what we ask for, not what every model
# reliably produces — stopping at the first blank line or the first `{`
# (where tool-call JSON would start) so it doesn't swallow anything else.
_UNFENCED_PLAN_RE = re.compile(
    r"^\s*(flowchart\s+(?:LR|RL|TD|TB)\b.*?)(?=\n\s*\n|\{|\Z)",
    re.IGNORECASE | re.DOTALL,
)


def _extract_plan_diagram(content: str) -> tuple[str | None, str | None, str]:
    """
    Pulls a plan flowchart (fenced, or bare text — see _UNFENCED_PLAN_RE) out
    of an assistant response, plus the one-sentence plain-language summary
    the system prompt (rule 6) asks the model to write immediately before the
    fence — a diagram alone doesn't tell a user what's about to happen, only
    the sentence does. Returns (diagram_or_None, summary_or_None,
    content_with_both_removed) — the caller uses the stripped content
    everywhere else (tool-call detection, history, final answer) so neither
    the diagram nor its lead-in sentence ever leaks into those.
    """
    match = _PLAN_FENCE_RE.search(content)
    if match:
        diagram = match.group(1).strip()
        summary = content[:match.start()].strip() or None
        remaining = content[match.end():].strip()
        return diagram or None, summary, remaining

    unfenced = _UNFENCED_PLAN_RE.match(content)
    if unfenced:
        # No lead-in sentence is available in this fallback shape — the
        # match starts at the very beginning of the response (^\s*), so
        # there's nothing before it to have been a summary.
        diagram = unfenced.group(1).strip()
        remaining = content[unfenced.end():].strip()
        return diagram or None, None, remaining

    return None, None, content

# Confirmed against qwen2.5-coder:7b via Ollama: after a long tool-schema-
# heavy conversation, the model occasionally answers a plain question (no
# tool calls at all) with a single bare word echoed from a JSON-schema key
# it saw repeated throughout the tool definitions, instead of real text.
_DEGENERATE_REPLIES = {
    "description", "name", "arguments", "parameters", "properties",
    "type", "schema", "function", "tool", "required",
}


def _is_degenerate_reply(text: str) -> bool:
    return text.strip().strip("\"'").lower() in _DEGENERATE_REPLIES


# Confirmed against a real turn (gemini-3.6-flash, no fence at all this
# time): the model narrates an intent to delegate/act — "Delegate to home
# maintenance worker: ..." / "Would you like to proceed with this plan?" —
# and stops there with finish_reason "stop" and NO tool_calls whatsoever, no
# JSON anywhere for _extract_text_tool_calls to even find. The existing nudge
# retry below only fires when at least one tool call already ran THIS turn
# (tool_calls_log truthy), so a response that describes acting instead of
# acting, with zero tool calls, sails through untouched. Naming a real tool
# in prose without a matching tool_calls entry is a reliable signal the model
# meant to call it and didn't.
#
# The exact tool name rarely appears verbatim, though — confirmed against
# further live repro turns, the model paraphrases it ("delegate this task to
# a worker", "Next steps:\n1. Delegate a worker to search...") rather than
# writing the literal identifier "delegate_to_worker". An exact-substring
# check missed both. This now does a word-level match instead: split the
# tool name on "_", drop short stopwords, and require every remaining
# significant word to appear somewhere in the text — "delegate_to_worker"
# becomes {"delegate", "worker"}, both of which those paraphrases contain.
_NAME_STOPWORDS = {"to", "a", "the", "of", "for", "with", "and"}


def _mentions_uncalled_tool(text: str, tool_names: set[str]) -> bool:
    lowered = text.lower()
    for name in tool_names:
        words = [w for w in name.lower().split("_") if w and w not in _NAME_STOPWORDS]
        if words and all(w in lowered for w in words):
            return True
    return False


# Separately: some turns narrate a not-yet-executed plan using no tool-name
# words at all ("I'll look up listings for each role and compare their pay.")
# and simply stop, with the same zero-tool-calls/finish_reason "stop" shape.
# These share a family of future-intent phrasing a completed answer wouldn't
# use — a model presenting real findings doesn't preface them with "I'll" or
# "Next steps:". Matched independently of tool-name overlap so a paraphrase
# with no lexical overlap with any tool name is still caught.
_NARRATION_INTENT_RE = re.compile(
    r"\bi'll\b|\bi will\b|\blet'?s\b|\bnext steps?:|\bwould you like\b|"
    r"\bplease wait\b|\bshall i\b|\bshould i proceed\b",
    re.IGNORECASE,
)

# Confirmed live complaint: the agent sometimes declines outright — no tool
# call, no narrated intent to make one, just "I can't help with that" — for
# requests its actual tools (fetch_page, search_jobs, delegate_to_worker)
# could have made progress on. Neither _mentions_uncalled_tool nor
# _NARRATION_INTENT_RE catches this, since a flat refusal names no tool and
# describes no future action at all. Matched only when zero tool calls have
# happened yet THIS request (tool_calls_log/delegation_count both empty) —
# a decline after genuinely trying and coming up empty is legitimate and
# must not be nudged into a loop.
_REFUSAL_RE = re.compile(
    r"\bi can'?t\b|\bi cannot\b|\bi'?m (?:not able|unable)\b|"
    r"\bi don'?t have (?:the )?(?:ability|capability|access)\b|"
    r"\bi do not have (?:the )?(?:ability|capability|access)\b|"
    r"\bunfortunately,? i (?:can'?t|cannot|am unable)\b|"
    r"\bi'?m sorry,? but\b|\bas an ai\b",
    re.IGNORECASE,
)

# Confirmed live complaint: the model sometimes writes a plausible-looking
# markdown link — [Acme Careers](https://acme.com/careers) — from training
# data/memory rather than from any URL a tool actually returned this turn.
# It reads exactly like a real, sourced link, so there's no way for the user
# to tell it's fabricated until they click it. Rather than trust the system
# prompt's own instruction not to do this (rule 3 below), every markdown
# link in the final answer is cross-checked against URLs that genuinely came
# back from a tool this turn (fetch_page's resolved `url`, search_jobs'
# `redirect_url`, an MCP/generated tool's own output — scraped generically
# out of each tool_calls_log entry's raw JSON `result` string rather than
# parsing each tool's response shape individually) plus any URL already
# present in the conversation history (the user's own words, or an earlier
# turn's already-verified reply) — a link backed by neither is demoted to
# plain text instead of being shown as a real, clickable one.
# Optional leading "!" also matches markdown IMAGE syntax (![alt](url)) —
# deliberate, not an oversight: rule 3b's ban on fabricated image URLs is
# enforced by this exact same verified-URL mechanism, not a separate check.
_MD_LINK_RE = re.compile(r"(!)?\[([^\]]*)\]\((https?://[^\s)]+)\)")
_URL_IN_TEXT_RE = re.compile(r"https?://[^\s\"'\\]+")


def _collect_verified_urls(tool_calls_log: list[dict], history: list) -> list[str]:
    urls: list[str] = []
    for entry in tool_calls_log:
        urls.extend(_URL_IN_TEXT_RE.findall(entry.get("result") or ""))
    for m in history:
        content = m.get("content")
        if isinstance(content, str):
            urls.extend(_URL_IN_TEXT_RE.findall(content))
    return urls


def _url_is_verified(url: str, verified_urls: list[str]) -> bool:
    # Strip trailing punctuation a model tacks onto a copied URL from its own
    # prose (a closing paren/period) before comparing — that shouldn't fail
    # an otherwise-real link. A substring match either way tolerates minor
    # differences (tracking params, trailing slash) between the URL a tool
    # returned and how the model reproduced it.
    candidate = url.rstrip(".,;:)")
    return any(candidate == real or candidate in real or real in candidate for real in verified_urls)


def _strip_unverified_links(text: str, tool_calls_log: list[dict], history: list) -> tuple[str, int]:
    verified = _collect_verified_urls(tool_calls_log, history)
    demoted = 0

    def _replace(match: re.Match) -> str:
        nonlocal demoted
        label, url = match.group(2), match.group(3)
        if _url_is_verified(url, verified):
            return match.group(0)
        demoted += 1
        return label

    return _MD_LINK_RE.sub(_replace, text), demoted


def _extract_text_tool_calls(content: str | None, valid_names: set[str]):
    """
    Some local models served through Ollama's OpenAI-compatible endpoint don't
    reliably populate the structured `tool_calls` field on the response —
    confirmed directly against qwen2.5-coder:7b: a tool-eligible prompt comes
    back with `tool_calls=None` and `content` holding the call as bare JSON
    instead, e.g. '{"name": "delegate_to_worker", "arguments": {...}}', and for
    multiple calls, one such JSON object per line rather than a JSON array.
    Without this, that raw JSON gets shown to the user as if it were the
    model's final answer instead of being executed.

    Returns a list of (name, arguments) tuples, or None if `content` isn't
    (only) one or more such tool-call objects — callers fall back to treating
    it as ordinary final text in that case, so a message that's genuinely
    prose (even prose that happens to mention a tool by name) is never
    mistaken for a call.
    """
    if not content:
        return None
    text = content.strip()
    fence = _FENCE_RE.match(text)
    if fence:
        text = fence.group(1).strip()
    if not text:
        return None

    def _as_call(obj):
        if not isinstance(obj, dict):
            return None
        name, args = obj.get("name"), obj.get("arguments")
        return (name, args) if name in valid_names and isinstance(args, dict) else None

    try:
        parsed = json.loads(text)
        candidates = parsed if isinstance(parsed, list) else [parsed]
        calls = [c for c in (_as_call(c) for c in candidates) if c]
        if len(calls) == len(candidates):
            return calls
        return None
    except json.JSONDecodeError:
        pass

    # Fall back to one JSON object per non-blank line.
    calls = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            calls = None
            break
        call = _as_call(obj)
        if not call:
            calls = None
            break
        calls.append(call)
    if calls:
        return calls

    # Fall back further to a JSON array of calls embedded inside narration —
    # confirmed against qwen2.5-coder:7b: instead of populating tool_calls,
    # the model narrates its plan in prose, emits a `[...]` array of the
    # actual (distinct) calls it intends to make, then narrates again
    # ("I will wait for each worker..."). Deliberately requires an ARRAY
    # specifically (not a bare single `{...}`) before ignoring surrounding
    # text: a lone JSON object floating in an explanation is far more often
    # a genuinely illustrative example ("here's what a call looks like: ...")
    # than an intended call, whereas a model bundling multiple real calls
    # into one text turn consistently wraps them in an array — the shape
    # its tool_calls list would have had if the structured field had worked.
    decoder = json.JSONDecoder()
    array_start = text.find("[")
    if array_start != -1:
        try:
            obj, _end = decoder.raw_decode(text, array_start)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, list) and obj:
            calls = [c for c in (_as_call(c) for c in obj) if c]
            if len(calls) == len(obj):
                return calls

    # Fall back further to one-or-more bare JSON call objects, each on its
    # own line, allowed to be preceded by ordinary narration lines. Confirmed
    # against a real turn: "I'm about to fetch the population data for
    # Sydney, Melbourne, and Brisbane.\n\n{\"name\": \"fetch_page\", ...}\n
    # {...}\n{...}" — case 2 above requires EVERY line to be JSON, so it
    # aborts on that leading sentence and the raw JSON gets shown to the user
    # as the final answer instead of being executed. Once the first line
    # starting with '{' appears, every subsequent non-blank line must itself
    # be a valid call — a stray '{' inside genuine prose that isn't followed
    # by more call lines still fails this and falls through, so an isolated
    # illustrative example is not mistaken for a real call.
    calls = []
    started = False
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if not started:
            if not line.startswith("{"):
                continue
            started = True
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            calls = None
            break
        call = _as_call(obj)
        if not call:
            calls = None
            break
        calls.append(call)
    if calls:
        return calls

    # Fall back further to whitespace-concatenated JSON objects with no
    # separators at all. Two distinct shapes land here:
    #   (a) confirmed against qwen2.5-coder:7b — a stuck local model
    #       repeating the SAME tool-call object over and over on one line
    #       (e.g. `{"name": "search_jobs", ...} {"name": "search_jobs",
    #       ...} ...`) with no natural stop, until max_tokens cuts it off;
    #   (b) confirmed against a real turn — several genuinely DISTINCT tool
    #       calls back to back with no array wrapper and no newlines between
    #       them at all (e.g. search_jobs, then fetch_page, then
    #       save_output), which the array/per-line fallbacks above don't
    #       catch because there's no `[` and no `\n` to split on.
    # Only accepted when the WHOLE text decodes this way with nothing left
    # over — a real call followed by genuine trailing prose fails to parse
    # past that point and is correctly rejected (prose isn't valid JSON), so
    # this can't misfire on "here's an example call: {...} anyway, ...".
    calls = []
    pos = 0
    length = len(text)
    while pos < length:
        while pos < length and text[pos].isspace():
            pos += 1
        if pos >= length:
            break
        try:
            obj, end = decoder.raw_decode(text, pos)
        except json.JSONDecodeError:
            calls = []
            break
        call = _as_call(obj)
        if not call:
            calls = []
            break
        calls.append(call)
        pos = end

    if not calls:
        # Confirmed against a real turn (gemini-3.6-flash): narration and its
        # tool call landing on the SAME line, with no fence and no separator
        # at all — "I'll search job market trends in Melbourne.
        # {\"name\": \"search_jobs\", \"arguments\": {...}}". None of the
        # per-line fallbacks above catch this because the JSON doesn't start
        # its own line — it's appended directly after the narration sentence,
        # so `line.startswith("{")` (case 4 above) never sees it. Find the
        # first '{' anywhere in the text and try to parse exactly one call
        # from there, requiring nothing but whitespace to remain afterward —
        # deliberately stricter than the embedded-fence fallback below (no
        # trailing prose allowed), since without a fence there's no other
        # signal separating "the call" from unrelated content that follows it.
        brace = text.find("{")
        if brace != -1:
            try:
                obj, end = decoder.raw_decode(text, brace)
                call = _as_call(obj)
                if call and not text[end:].strip():
                    calls = [call]
            except json.JSONDecodeError:
                pass

    if not calls:
        # Last resort: a fenced JSON object/array embedded anywhere inside
        # otherwise-unparseable prose (see _EMBEDDED_FENCE_RE above). Unlike
        # every fallback so far, this deliberately ignores surrounding text
        # instead of requiring the whole message to decode — narration before
        # or after a genuine embedded call is expected here, not a sign the
        # match is spurious, since a call floating alone with no fence (a
        # lone `{...}` in an explanation) is already handled, and rejected,
        # by the array-only rule above.
        embedded = []
        for fence_match in _EMBEDDED_FENCE_RE.finditer(text):
            try:
                obj = json.loads(fence_match.group(1))
            except json.JSONDecodeError:
                continue
            candidates = obj if isinstance(obj, list) else [obj]
            found = [c for c in (_as_call(c) for c in candidates) if c]
            if len(found) == len(candidates):
                embedded.extend(found)
        if not embedded:
            return None
        calls = embedded

    # A degenerate repeat of the exact same call collapses to one instance —
    # the model only meant to make it once. Otherwise, the distinct calls are
    # each real and are returned as-is.
    seen = {(name, json.dumps(args, sort_keys=True)) for name, args in calls}
    if len(seen) == 1 and len(calls) >= 2:
        return [calls[0]]
    return calls

_PRIMITIVE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_jobs",
            "description": (
                "Search live job listings via the Adzuna Job Search API — a real API, not "
                "scraping. Use this for ANY job search, salary research, or job-market task. "
                "Prefer this over fetch_page against SEEK/Indeed/LinkedIn: those block "
                "datacenter traffic with a 403 regardless of headers, this doesn't."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "description": "Job title or keywords, e.g. 'software engineer'"},
                    "where": {"type": "string", "description": "Location, e.g. 'Melbourne'. Optional — omit for nationwide."},
                    "country": {"type": "string", "description": "Two-letter Adzuna country code, default 'au'."},
                    "results_per_page": {"type": "integer", "description": "Max 50, default 20."},
                    "page": {"type": "integer", "description": "Page number for pagination, default 1."},
                    "distance_km": {"type": "integer", "description": "Search radius in km around 'where'. Only meaningful when 'where' is also given."},
                },
                "required": ["what"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": (
                "Fetch any public web page and return its clean text content (HTML, scripts, "
                "and SVG stripped). Use this for company pages, news, or any general URL. "
                "For job listings/salary data, use search_jobs instead — job boards block "
                "scraping from this server's IP."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL to fetch"}
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_image",
            "description": (
                "Find one real, freely-licensed illustrative image for a topic via "
                "Wikipedia/Wikimedia (no scraping, a real lookup API). Returns a single "
                "best-match thumbnail URL, never a gallery. Use sparingly, only when an "
                "image would genuinely help illustrate a finding — your written analysis "
                "is always the primary output, an image is supplementary polish on top of "
                "it, never a substitute for discussing the finding in prose."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The topic/subject to find an illustrative image for, e.g. 'Great Barrier Reef'"}
                },
                "required": ["query"],
            },
        },
    }
]

_SEARCH_TOOL_NAMES = {
    "web_search", "search_web", "google_search", "bing_search",
    "search", "search_internet", "internet_search",
}

# Multi-agent orchestration, first scaffold (CLAUDE.md roadmap item 1).
# Available to the main agent only — passing allow_delegation=False (used when
# orchestrator.run_worker runs a worker's own loop) omits this tool entirely,
# so a worker never sees it and can't spawn further sub-workers. One level deep
# for now.
_DELEGATE_TOOL = {
    "type": "function",
    "function": {
        "name": "delegate_to_worker",
        "description": (
            "Spin up a fresh worker agent — with its own name, personality, and "
            "purpose-built toolset — to independently handle ONE focused, "
            "self-contained subtask, then hand its finished result back to you. "
            "Use this to split a genuinely separable request into parts a "
            "specialist can each own, rather than doing everything yourself with "
            "one toolset. The worker does not see this conversation — give it "
            "everything it needs via `task` and `context`."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "A complete, self-contained description of the subtask for the worker to accomplish.",
                },
                "context": {
                    "type": "string",
                    "description": "Optional extra background or data (e.g. results from your own earlier tool calls) the worker needs but `task` alone doesn't convey.",
                },
            },
            "required": ["task"],
        },
    },
}

MAX_DELEGATIONS_PER_REQUEST = 6

# Hard ceiling on total tool calls processed in a SINGLE assistant turn,
# regardless of tool type. MAX_DELEGATIONS_PER_REQUEST only bounds how many
# delegate_to_worker calls actually spawn a worker — it does nothing about
# the calls beyond that limit, which the loop below still iterates over,
# logs, and streams. Confirmed live: a model can spiral into a degenerate
# repetition loop and emit ~90 near-duplicate delegate_to_worker calls in
# one response (e.g. "fix a leaky shower drain flange" / "...plug" /
# "...lid" / "...strainer" ad infinitum) — even capped at 6 real spawns,
# the other ~84 still each got a tool_start/tool_result round trip and a
# tool_calls_log entry, flooding the UI and bloating the next turn's
# context for no benefit. Calls beyond this cap are rejected cheaply (no
# execution, no worker spawn, no stream event) with a short tool-result
# error telling the model to stop and answer — one response per
# tool_call_id is still required or the next API call errors on a missing
# tool result.
MAX_TOOL_CALLS_PER_TURN = 20


def _delegation_rule_body(keywords: list[str], max_delegations: int) -> str:
    """
    Rule 6's body, in the system prompt built by run_agent_stream.

    An agent bootstrapped with a specialty pool (agent_config["keywords"],
    the "Saved Specialties" the user configured on the Setup screen) should
    run *any* task the user gives it across that whole pool, not only a
    request that happens to spell out a comma-separated keyword list — the
    pool itself is the keyword source once one exists. Without a pool, fall
    back to the original behavior of extracting distinct keywords/topics
    from the request text itself.
    """
    if keywords:
        pool = ", ".join(keywords)
        return f"""
   This agent's configured specialty pool is: {pool}. Whatever task the
   user just gave you, run it across EVERY specialty in that pool, not
   only ones the message happens to name — the pool itself is the set of
   keywords/topics to search, regardless of how the request is worded.
   Delegate ONE worker per specialty, and fold BOTH pieces into that
   worker's `task`: the specialty itself AND whatever the user actually
   asked for (e.g. task = "<specialty>: <the user's request>") — never
   delegate on the bare specialty name alone, and never drop what the
   user said in favor of just the keyword. Exception: if the user's
   message clearly narrows things to only one or a few specialties from
   the pool, delegate for just those; if the request has nothing to do
   with the pool at all, handle it yourself instead. Call every
   delegate_to_worker you need before writing your own findings. Limit:
   {max_delegations} per turn — if the pool has more entries
   than that, delegate as many as the limit allows and handle the rest
   yourself with your own tools."""
    return f"""
   First, identify the distinct tasks the request actually requires. When
   it names multiple distinct keywords, topics, roles, or subjects to
   search/research (e.g. a request listing several comma-separated items —
   "python developer, react developer", "renewable energy, EV batteries,
   grid storage"), you MUST delegate ONE worker per keyword/topic, each
   with a `task` scoped to that single item — never research more than one
   keyword/topic yourself with your own tools when the request names
   several. Call every `delegate_to_worker` you need before writing your
   own findings. For a single keyword, or a request with no genuinely
   separable parts, handle it yourself instead — delegating a one-part
   task just adds latency for no benefit. Limit:
   {max_delegations} per turn — if there are more keywords than
   that, handle the remainder yourself with your own tools after delegating
   as many as the limit allows."""


def run_agent_stream(messages: list, agent_config: dict, allow_delegation: bool = True):
    """
    Generator that yields event dicts as the agent loop runs.

    Event shapes:
      {"type": "plan",        "diagram": "...", "summary": "..." | None}  # emitted at most once, before the first tool_start
      {"type": "tool_start",  "tool": "name", "inputs": {...}}
      {"type": "tool_result", "tool": "name", "result": "..."}
      {"type": "done",        "response": "...", "tool_calls": [...], "duration_seconds": N}
      {"type": "error",       "message": "..."}

    allow_delegation gates the delegate_to_worker primitive (see _DELEGATE_TOOL
    above) — False when this call itself IS a worker's loop, to keep
    orchestration one level deep.
    """
    # User-configurable overrides set on the Settings screen (SettingsModal.tsx)
    # and threaded onto AgentConfig client-side, same pattern as provider/
    # ollama_model — fall back to the platform defaults when unset (older
    # saved chats/drafts predate these fields).
    max_delegations = agent_config.get("max_delegations") or MAX_DELEGATIONS_PER_REQUEST
    search_defaults = agent_config.get("search_defaults") or {}
    # search_jobs is only meaningful for a job-search agent — a general/research
    # agent given the same tool would sometimes reach for it on any keyword that
    # sounded job-adjacent. Gated by template rather than by prompt wording alone
    # so it's actually absent from the tool list the model sees, not just
    # discouraged.
    is_job_search_agent = agent_config.get("template") == "job_search"
    # These two phrases used to be hardcoded unconditionally, so even a
    # general/research agent (no search_jobs in its tool list at all) was
    # told in its own system prompt that it had a job-search tool and that
    # its "mandatory output" was job titles/salaries/companies — priming it
    # to frame unrelated answers as job-search results. Gated the same way
    # rule 2 below already was.
    _tool_list_desc = "fetch_page, search_jobs, search_image, delegate_to_worker" if is_job_search_agent else "fetch_page, search_image, delegate_to_worker"
    _findings_desc = "listing counts, job titles, salary ranges, company names" if is_job_search_agent else "key facts, figures, names, and comparisons"

    system_prompt = agent_config["system_prompt"] + f"""

---
CRITICAL TOOL RULES — READ BEFORE CALLING ANY TOOL:

NEVER decline a request outright before actually attempting it with the real tools listed below
({_tool_list_desc}, and this agent's own configured tools). "I can't help
with that" with zero tool calls made is almost always wrong — try first, and only say you can't if
an actual attempt genuinely came up empty.

1. DO NOT call `web_search` or any generic search tool. There is no search engine connected. Every call returns 0 results and wastes a turn.
""" + ("""
2. For job search, salary research, or job-market questions, USE `search_jobs` — it calls a real
   job search API and returns structured listings (title, company, location, salary, apply URL).
   Do NOT use `fetch_page` against SEEK/Indeed/LinkedIn or similar job boards — they block this
   server's IP with a 403 regardless of headers, so it will not work.
""" if is_job_search_agent else "") + f"""
3. USE `fetch_page` for everything else — company pages, news, general URLs. It returns
   text ONLY (HTML and scripts stripped) — it cannot fetch or embed an image itself.
   NEVER invent a URL from memory or a guess at what one "would probably be"
   (e.g. guessing a company's careers page follows some common URL pattern).
   Only write a `[text](url)` link whose url is one a tool actually returned
   to you this turn (fetch_page's resolved page URL, search_jobs' listing
   URLs, or a URL already present in the conversation) — if you don't have
   a real URL for something, name it in plain text with no link at all
   rather than fabricate one. A markdown link whose URL wasn't backed by an
   actual tool result is removed from your reply before the user sees it,
   so a fabricated one only wastes the user's trust for nothing.

3b. YOUR WRITTEN ANALYSIS IS ALWAYS THE PRIMARY OUTPUT — an image is, at
   most, supplementary illustration on top of it, never a replacement for
   discussing a finding in your own words. When (and only when) a real
   picture would genuinely help — a place, a species, a landmark, a
   product, something visual the user is asking about — call `search_image`
   with the topic. If it returns an `image_url`, embed it in your reply as
   a plain markdown image: `![description](image_url)`. If it returns an
   error (no match / no image available), say so briefly in plain text and
   move on — do not retry it repeatedly, and do not apologize at length.
   NEVER write a `![...](...)` image whose url wasn't the literal
   `image_url` a `search_image` call actually returned this turn — the
   same fabrication rule as links above applies to images. Don't call
   `search_image` reflexively on every message; use it only when a visual
   would add real value to what you're already reporting.

4. MANDATORY OUTPUT: When all fetches are done, write the actual findings — {_findings_desc}. Do not say "search complete" or list tool names. The user cannot see tool output; your reply IS the report.

5. DISCUSS AND ANALYSE YOUR FINDINGS IN REAL PROSE — A DIAGRAM IS A BONUS,
   NEVER A REPLACEMENT. Your job is to actually talk through what you found:
   the specific names, numbers, and details; what's notable, surprising, or
   worth a second look; how things compare and why that matters; caveats or
   gaps in what you could find. Write this out properly, in full sentences —
   never compress a real finding down to a diagram plus a one-line caption.
   Only AFTER that discussion, if the findings ALSO involve a numeric
   comparison, distribution, or breakdown by category with several distinct
   values (e.g. salary ranges across many roles, counts by location or
   company), you may additionally draw a Mermaid diagram in a ```mermaid
   fenced code block as a visual aid alongside your discussion — use `pie` or
   `xychart-beta` for distributions/comparisons, `flowchart`/`graph` for a
   process or relationship, `mindmap` for a grouped breakdown of topics. This
   is optional polish, not a requirement, and it is never a substitute for
   the discussion above — if you're unsure whether a diagram would add
   anything, skip it and just write the analysis. Don't force one for a
   single flat fact or a short list with nothing to compare. In a `pie` or
   `xychart-beta` block, every value MUST be a bare number Mermaid can
   parse (e.g. `"Sydney" : 5200000`) — never a unit suffix or word like
   `5M`, `$120k`, or `"about 5 million"`; that fails to parse and the
   diagram silently doesn't render at all. Put the unit in the title or
   your discussion text instead (e.g. title `"Population (millions)"`
   with bare values `5.2`).

6. BEFORE doing anything else this turn, if the task needs more than one step
   (multiple tool calls, delegated workers, or several distinct pieces of
   research), sketch your plan as a short Mermaid flowchart in a
   ```mermaid-plan fenced code block (a different fence from ```mermaid,
   which is reserved for a diagram in your FINAL answer) as the very first
   thing in your response, before making any tool calls. Immediately before
   that fence, on its own line, write ONE short plain-language sentence
   summarizing what you're about to do — this is the only context the user
   sees for the plan diagram, so it MUST always be there, e.g. "I'll look up
   listings for each role and compare their pay." Then the fence. It MUST
   start with `flowchart LR` (or `flowchart TD`) on its own line, then the
   actual steps you're about to take, e.g.:
   I'll look up listings for each role and compare their pay.
   ```mermaid-plan
   flowchart LR
     Start --> A[Search X] --> B[Search Y] --> C[Compare] --> Answer
   ```
   Max ~8 nodes. Skip this entirely for a simple, single-step question that
   needs no tools or just one tool call. Every node label MUST be plain text
   with NO `[`, `]`, or `"` characters inside it (e.g. write `Compare
   providers reviews and prices`, never `Compare providers' reviews]` or
   anything containing a bracket) — a stray bracket inside a label breaks
   the node's own `[...]` boundary and the whole diagram fails to parse.
   Keep each label to a few plain words; drop punctuation rather than risk
   it.

7. BE ASSERTIVE, NOT TERSE. State your findings and recommendations directly
   — "X is the better choice because Y," not "X might possibly be worth
   considering, though it depends." Lead with a conclusion, then back it
   with the evidence, instead of hedging your way toward one. If the data is
   genuinely inconclusive, say so plainly and explain why, rather than
   burying a wishy-washy answer in qualifiers. Don't over-hedge with
   "it depends," "you may want to," or "consider" when you actually have
   an opinion backed by what you found — give the opinion. Being assertive
   is about confidence, not brevity — it does not mean cutting the actual
   discussion of your findings short (see rule 5); a confident one-line
   verdict with no analysis behind it is just as unhelpful as a hedgy one.
""" + (f"""
8. You also have `delegate_to_worker`.{_delegation_rule_body(agent_config.get("keywords") or [], max_delegations)}
9. Once your workers report back, do NOT restate or re-summarize each one's
   full findings in your own reply — the user already sees each worker's
   complete response individually, attributed to that worker, in the UI.
   Your own reply should be short: at most a few sentences comparing or
   synthesizing across workers (or noting anything none of them covered),
   never a repeat of content they already reported.
10. DRIVE THE CONVERSATION FORWARD.""" if allow_delegation else """
8. DRIVE THE CONVERSATION FORWARD.""") + """ This is a discussion with the
   user, not a one-shot report — treat it that way. After you've laid out
   your findings (rule 5), actually engage with what they mean: raise a
   genuine follow-up question when something you found is ambiguous, when
   the user's next move depends on a preference you don't know (budget,
   priority, timeframe), or when digging one level deeper would clearly
   help — a real question inviting their input, not a rhetorical one. Close
   with a specific next move — a question worth answering, a comparison to
   add, a next report to run — phrased as a suggestion the user can accept
   or ignore, never a vague "let me know if you have any questions" and
   never a generic prompt disconnected from what you just found. Skip this
   only for a trivial exchange: a greeting or a case where there is
   genuinely nowhere further to take it.
---"""

    tool_definitions = agent_config["tools"]

    primitive_tools = _PRIMITIVE_TOOLS if is_job_search_agent else [
        t for t in _PRIMITIVE_TOOLS if t["function"]["name"] != "search_jobs"
    ]
    tools = primitive_tools + ([_DELEGATE_TOOL] if allow_delegation else []) + [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in tool_definitions
    ]

    # Keyed by name -> the full tool def, not just `implementation`, so
    # dispatch below can tell a generated tool from an MCP-backed one
    # (CLAUDE.md MCP priority 6) and route accordingly.
    tool_def_map = {t["name"]: t for t in tool_definitions}
    tool_names = {t["function"]["name"] for t in tools}
    provider = agent_config.get("provider")
    model = agent_config.get("ollama_model")

    # Build initial message list: system prompt first, then conversation history
    current_messages: list[dict] = [{"role": "system", "content": system_prompt}]
    for m in messages:
        image = m.get("image")
        if not image:
            current_messages.append({"role": m["role"], "content": m["content"]})
            continue
        if provider == "ollama":
            # Local Ollama models in this cascade aren't vision-capable — drop
            # the image rather than send a content shape it can't handle, but
            # say so, so the agent doesn't just silently ignore the attachment.
            note = (
                "[The user attached a diagram image, but this agent is running "
                "on a local Ollama model, which can't see images. Ask them to "
                "describe the diagram in words, or switch the agent to the "
                "Gemini provider to analyze it directly.]"
            )
            content = f"{m['content']}\n\n{note}" if m["content"] else note
            current_messages.append({"role": m["role"], "content": content})
            continue
        # OpenAI-compatible multimodal content (Gemini's endpoint accepts this
        # transparently — see llm_client.py) — one text block plus one image
        # block. A default critique prompt covers the case where the user
        # attached an image with no message of their own.
        text = m["content"] or (
            "Critique this diagram's structure — dead-end branches, redundant "
            "boxes, unclear or missing labels, unnecessary complexity — then "
            "offer to rebuild it as a cleaner mermaid diagram."
        )
        current_messages.append({
            "role": m["role"],
            "content": [
                {"type": "text", "text": text},
                {"type": "image_url", "image_url": {"url": image}},
            ],
        })

    tool_calls_log = []
    started_at = time.time()
    total_input_tokens = 0
    total_output_tokens = 0
    # Confirmed live: one nudge attempt is sometimes not enough — a model that
    # narrates-instead-of-calling once will sometimes repeat that exact
    # pattern after being corrected once, and a single-shot budget meant the
    # second occurrence fell straight through to being shown (and persisted
    # into history) as if it were a real, completed answer. Same bounded
    # retry shape as degenerate_retries below, not unlimited — a model that's
    # still stuck after two corrections is treated as genuinely done.
    nudge_retries = 0
    degenerate_retries = 0
    delegation_count = 0
    # Hard ceiling on LLM calls per request — without this, a model stuck in a
    # tool-calling loop (or a buggy tool) burns unlimited API quota on one request.
    max_iterations = 25

    try:
        for iteration in range(max_iterations):
            response = create_chat_completion(
                provider=provider,
                model=model,
                max_tokens=16000,
                tools=tools,
                messages=current_messages,
            )

            choice = response.choices[0]
            message = choice.message
            finish_reason = choice.finish_reason

            if response.usage:
                total_input_tokens += response.usage.prompt_tokens
                total_output_tokens += response.usage.completion_tokens

            # The model's own step-by-step plan (system prompt rule 6) only
            # makes sense on the very first turn, before any tool calls have
            # run — strip it out of the content used everywhere else below
            # (tool-call detection, history, final answer) so it never leaks
            # into any of those, and stream it as its own event right away.
            raw_content = message.content
            if iteration == 0 and raw_content:
                plan_diagram, plan_summary, raw_content = _extract_plan_diagram(raw_content)
                if plan_diagram:
                    yield {"type": "plan", "diagram": plan_diagram, "summary": plan_summary}

            # Append assistant turn to history. Dump the full raw message rather
            # than hand-picking fields (id/type/function) — Gemini's "thinking"
            # models attach a thought_signature to each function-call part and
            # require it echoed back verbatim on the next turn, or the next call
            # 400s with "Function call is missing a thought_signature"
            # (https://ai.google.dev/gemini-api/docs/thinking#signatures). The
            # openai SDK's models are extra="allow", so model_dump() preserves
            # whatever provider-specific extras came back instead of silently
            # dropping them.
            assistant_msg = message.model_dump(exclude_none=True)
            assistant_msg["role"] = "assistant"
            assistant_msg["content"] = raw_content or ""

            # Some models (confirmed: qwen2.5-coder:7b via Ollama's OpenAI-
            # compatible endpoint) don't populate the structured tool_calls
            # field at all — they print the call as bare JSON in `content`
            # instead. Detect that shape here so it gets executed like a real
            # tool call instead of being shown to the user as the final answer.
            effective_tool_calls = message.tool_calls
            synthetic_calls = None
            if not effective_tool_calls:
                extracted = _extract_text_tool_calls(raw_content, tool_names)
                if extracted:
                    synthetic_calls = [
                        SimpleNamespace(
                            id=f"synthetic_call_{i}",
                            function=SimpleNamespace(name=name, arguments=json.dumps(args)),
                        )
                        for i, (name, args) in enumerate(extracted)
                    ]
                    effective_tool_calls = synthetic_calls
                    # Replace the raw-JSON content with what it would have
                    # been had the model used real tool_calls — empty, with
                    # the calls carried in their own field — so conversation
                    # history sent back to the model next turn stays clean.
                    assistant_msg["content"] = ""
                    assistant_msg["tool_calls"] = [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                        }
                        for tc in synthetic_calls
                    ]

            current_messages.append(assistant_msg)

            # No tool calls → final response
            if not effective_tool_calls:
                final_text = raw_content or ""
                described_not_called = (
                    not tool_calls_log
                    and not delegation_count
                    and (
                        _mentions_uncalled_tool(final_text, tool_names)
                        or bool(_NARRATION_INTENT_RE.search(final_text))
                    )
                )
                outright_decline = (
                    not tool_calls_log
                    and not delegation_count
                    and not described_not_called
                    and bool(_REFUSAL_RE.search(final_text))
                )
                # A bare schema-key word ("description", "name", ...) leaked
                # instead of real text is unambiguous — there's no plausible
                # reading where that's a genuine answer — so it gets its own,
                # more generous retry budget separate from the general nudge
                # below. Confirmed live: a single retry sometimes isn't
                # enough (the model repeats the same degenerate word once
                # more before recovering), so this allows up to two retries
                # before giving up, rather than the one-shot ceiling used for
                # the costlier/more ambiguous cases below.
                if (
                    finish_reason == "stop"
                    and degenerate_retries < 2
                    and _is_degenerate_reply(final_text)
                ):
                    degenerate_retries += 1
                    current_messages.append({
                        "role": "user",
                        "content": (
                            "That reply was not a real answer — just a stray schema word, "
                            "not actual content. Present your complete findings now in full "
                            "detail, in plain language, not a fragment of a tool schema."
                        ),
                    })
                    continue

                if (
                    nudge_retries < 2
                    and finish_reason == "stop"
                    and (
                        (tool_calls_log and len(final_text.strip()) < 400)
                        or described_not_called
                        or outright_decline
                    )
                ):
                    nudge_retries += 1
                    current_messages.append({
                        "role": "user",
                        "content": (
                            f"You declined without actually trying — you DO have real tools "
                            f"available ({_tool_list_desc}, and this "
                            "agent's own configured tools). Attempt the task with them now "
                            "before concluding you can't help. Only say you genuinely can't if, "
                            "after actually attempting it, you truly have no way to make progress."
                        ) if outright_decline else (
                            "You described taking an action (e.g. calling a tool) but did not "
                            "actually call it — make the real, structured tool call now instead "
                            "of describing or narrating it in text. If no tool call is actually "
                            "needed, present your complete findings in full detail instead."
                        ) if described_not_called else (
                            "Present your complete findings now in full detail. "
                            "Show the actual data, results, and analysis from your searches."
                        ),
                    })
                    continue

                final_text, stripped_link_count = _strip_unverified_links(final_text, tool_calls_log, messages)

                try:
                    last_user_message = next(
                        (m.get("content") for m in reversed(messages) if m.get("role") == "user"), ""
                    )
                    if not isinstance(last_user_message, str):
                        last_user_message = ""
                    for eval_result in eval_checks.check_chat_response(
                        last_user_message, final_text, tool_calls_log, stripped_link_count, provider, model,
                    ):
                        eval_log.record(eval_result)
                        yield {"type": "eval_result", **eval_result}
                except Exception as e:
                    logger.info("chat_response eval checks skipped: %s", e)

                yield {
                    "type": "done",
                    "response": final_text,
                    "tool_calls": tool_calls_log,
                    "duration_seconds": round(time.time() - started_at, 1),
                    "usage": {
                        "input_tokens": total_input_tokens,
                        "output_tokens": total_output_tokens,
                    },
                    "rate_limits": {
                        "tokens_limit": None,
                        "tokens_remaining": None,
                        "tokens_reset": None,
                        "requests_limit": None,
                        "requests_remaining": None,
                    },
                }
                return

            # Execute each tool call and collect results. delegate_to_worker
            # calls are independent of each other (separate bootstrapped
            # workers, no shared state) and are dispatched to a thread pool
            # instead of run one at a time — each is a blocking bootstrap +
            # agent-loop round trip over the network, so N of them used to
            # cost N times as long as the slowest one. Every other tool call
            # still runs synchronously in submission order, unchanged.
            tool_result_messages = []
            pending_workers: dict[int, tuple] = {}  # idx -> (future, tc, tool_name, tool_inputs, source)
            executor = None

            def _finish(tc, tool_name, tool_inputs, result, source):
                try:
                    result_str = json.dumps(result, default=str)
                except Exception:
                    result_str = str(result)
                tool_calls_log.append({
                    "tool": tool_name,
                    "inputs": tool_inputs,
                    "result": result_str,
                    "source": source,
                })
                tool_result_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_str,
                })
                return result_str

            def _tool_call_eval_events(tool_name, tool_inputs, tool_def, result_str, source, call_index):
                try:
                    for eval_result in eval_checks.check_tool_call(
                        tool_name, tool_inputs, tool_def, result_str, source, call_index,
                    ):
                        eval_log.record(eval_result)
                        yield {"type": "eval_result", **eval_result}
                except Exception as e:
                    logger.info("tool_call eval checks skipped: %s", e)

            for idx, tc in enumerate(effective_tool_calls):
                tool_name = tc.function.name
                try:
                    tool_inputs = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    tool_inputs = {}

                if idx >= MAX_TOOL_CALLS_PER_TURN:
                    result_str = json.dumps({
                        "error": (
                            f"Tool-call limit for this turn ({MAX_TOOL_CALLS_PER_TURN}) "
                            "reached — stop calling tools and answer now with what "
                            "you already have."
                        )
                    })
                    tool_result_messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result_str,
                    })
                    continue

                tool_def = tool_def_map.get(tool_name)
                source = "mcp" if tool_def and tool_def.get("source") == "mcp" else (
                    "primitive" if tool_name in ("fetch_page", "search_jobs", "search_image", "delegate_to_worker") else "generated"
                )
                yield {"type": "tool_start", "tool": tool_name, "inputs": tool_inputs, "source": source, "call_index": idx}

                if tool_name == "delegate_to_worker":
                    if delegation_count >= max_delegations:
                        result = {
                            "error": (
                                f"Delegation limit ({max_delegations}) reached "
                                "for this turn — finish the task yourself with the tools "
                                "you already have."
                            )
                        }
                        result_str = _finish(tc, tool_name, tool_inputs, result, source)
                        yield {"type": "tool_result", "tool": tool_name, "result": result_str, "source": source, "call_index": idx}
                        yield from _tool_call_eval_events(tool_name, tool_inputs, tool_def, result_str, source, idx)
                    else:
                        delegation_count += 1
                        # Deferred import: orchestrator imports run_agent_stream from
                        # this module, so importing it back at module load time would
                        # be circular. Safe here since it's only needed once this
                        # branch actually runs.
                        from orchestrator import run_worker
                        if executor is None:
                            executor = concurrent.futures.ThreadPoolExecutor(
                                max_workers=max_delegations
                            )
                        future = executor.submit(
                            run_worker,
                            task=tool_inputs.get("task", ""),
                            context=tool_inputs.get("context", ""),
                            provider=provider,
                            model=model,
                            search_defaults=search_defaults,
                            agent_type=agent_config.get("template"),
                        )
                        pending_workers[idx] = (future, tc, tool_name, tool_inputs, source)
                    continue

                if tool_name == "fetch_page":
                    result = fetch_page(tool_inputs.get("url", ""))
                elif tool_name == "search_jobs":
                    # The model can still override any of these per-call; the
                    # Settings-screen values (search_defaults) only fill in
                    # whatever it left out, same precedence as the "au"/20
                    # hardcoded fallbacks they replace.
                    result = search_jobs(
                        what=tool_inputs.get("what", ""),
                        where=tool_inputs.get("where", ""),
                        country=tool_inputs.get("country") or search_defaults.get("country") or "au",
                        results_per_page=tool_inputs.get("results_per_page") or search_defaults.get("results_per_page") or 20,
                        page=tool_inputs.get("page") or 1,
                        distance_km=tool_inputs.get("distance_km") or search_defaults.get("radius_km"),
                    )
                elif tool_name == "search_image":
                    result = search_image(tool_inputs.get("query", ""))
                elif tool_name in _SEARCH_TOOL_NAMES:
                    result = {
                        "error": (
                            "No generic search engine is connected. Do NOT call this tool again. "
                            "For job listings/salary data, call search_jobs instead. "
                            "For any other URL, use fetch_page."
                        )
                    }
                elif source == "mcp":
                    # Routed to the real vetted MCP server, not exec()'d —
                    # this is the whole point of CLAUDE.md's MCP priority 6:
                    # bootstrap picked the tool, never wrote its implementation.
                    result = mcp_client.call_tool(tool_def["mcp_server"], tool_def["mcp_tool"], tool_inputs)
                else:
                    implementation = tool_def["implementation"] if tool_def else "result = 'Unknown tool'"
                    result = execute_tool(implementation, tool_inputs)

                result_str = _finish(tc, tool_name, tool_inputs, result, source)
                yield {"type": "tool_result", "tool": tool_name, "result": result_str, "source": source, "call_index": idx}
                yield from _tool_call_eval_events(tool_name, tool_inputs, tool_def, result_str, source, idx)

            # Stream each delegated worker's result as soon as it finishes —
            # not in submission order — since running them concurrently only
            # helps the UI if a fast worker's card doesn't wait behind a slow
            # one.
            if pending_workers:
                future_to_idx = {info[0]: idx for idx, info in pending_workers.items()}
                for future in concurrent.futures.as_completed(future_to_idx):
                    idx = future_to_idx[future]
                    _, tc, tool_name, tool_inputs, source = pending_workers[idx]
                    try:
                        result = future.result()
                    except Exception as e:
                        result = {"error": f"Worker crashed: {e}"}
                    result_str = _finish(tc, tool_name, tool_inputs, result, source)
                    yield {"type": "tool_result", "tool": tool_name, "result": result_str, "source": source, "call_index": idx}
                    tool_def = tool_def_map.get(tool_name)
                    yield from _tool_call_eval_events(tool_name, tool_inputs, tool_def, result_str, source, idx)
                    # The worker's own checks (its bootstrap + delegation-fit
                    # judge, and eval_result events already relayed from its
                    # own inner run_agent_stream loop — see orchestrator.py's
                    # run_worker) were already recorded inside run_worker
                    # itself; relay them here without recording again.
                    if isinstance(result, dict) and result.get("eval_results"):
                        for eval_result in result["eval_results"]:
                            yield {"type": "eval_result", **eval_result}
                executor.shutdown(wait=False)

            current_messages.extend(tool_result_messages)

        yield {"type": "error", "message": f"Stopped after {max_iterations} tool-call rounds without a final answer."}

    except Exception as e:
        yield {"type": "error", "message": str(e)}
