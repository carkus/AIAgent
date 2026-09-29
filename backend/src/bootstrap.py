import ast
import json
import logging
import re
import uuid
from llm_client import create_chat_completion
import bootstrap_memory
import eval_checks
import eval_log
import mcp_client

logger = logging.getLogger(__name__)

_BOOTSTRAP_PROMPT = """\
You are a meta-agent configurator. A user wants a custom AI agent for the following purpose:

<purpose>
{purpose}
</purpose>
{image_note}{fewshot}
Design and configure this agent. Return a single JSON object with exactly these fields:

{{
  "persona": {{
    "name": "<a single surname-style name that fits this agent's purpose and tone — not a title, not the word \"Agent\", not a full name>",
    "traits": ["<adjective>", "<adjective>", "<adjective>"],
    "rationale": "<one sentence connecting the name/traits to the stated purpose>"
  }},
  "system_prompt": "<detailed role and behaviour instructions for the agent>",
  "tools": [
    {{
      "name": "<snake_case_name>",
      "description": "<what this tool does — the model reads this to decide when to call it>",
      "input_schema": {{
        "type": "object",
        "properties": {{
          "<param>": {{"type": "string", "description": "<what this param is>"}}
        }},
        "required": ["<param>"]
      }},
      "implementation": "<Python code as a string. Must assign result to `result` variable. See execution rules below.>"
    }}
  ]
}}

Execution environment for tool implementations:
- The following are pre-injected and ready to use WITHOUT importing: `requests`, `json`, `os`, `re`, `math`, `datetime`, `collections`, `urllib`
- Do NOT write import statements for any of the above — they are already available as module objects
- You MAY import other standard-library modules if needed (e.g. `import csv`, `import hashlib`)
- File writes: use `open(os.path.join(TEMP_DIR, filename), 'w')` — `TEMP_DIR` is pre-injected and resolves to the correct platform temp directory. Never hardcode /tmp/
- Always assign the final result to a variable named `result`
- Tool inputs are available as: `inputs` (dict), `input_data` (alias for `inputs`), or directly by name (e.g. if the tool has a `keyword` param, you can write `keyword` directly)

{primitives_block}
IMPORTANT: "always available to the agent" means the agent can call them as its own tool calls — it does NOT mean they exist as Python functions inside another generated tool's `implementation` string. Each `implementation` runs in its own isolated sandbox that only has `inputs`/`input_data`, `requests`, `json`, `os`, `re`, `math`, `datetime`, `collections`, `urllib`, and `TEMP_DIR` — never write `search_jobs(...)`, `fetch_page(...)`, `search_image(...)`, or `generate_image(...)` inside an `implementation` string. The same rule applies to every tool name in the "Vetted MCP tools" list below (e.g. `tavily_search`) — those are NOT Python functions either, in any implementation string. There is also no local HTTP service that runs or proxies these tools for you — never write `requests.get(...)`/`requests.post(...)` against `127.0.0.1`, `localhost`, or any local port to "call" a primitive or vetted MCP tool; nothing listens there and the request will simply fail. If a tool needs a primitive's or a vetted MCP tool's capability, don't generate a Python implementation for it at all — add the primitive by name to the system_prompt's instructions, or add the MCP tool using the exact `"source": "mcp"` object shape shown below, never a generated `implementation` that calls it like a function or proxies to it over HTTP.

Vetted MCP tools (real, independently-maintained servers — prefer these over writing your own implementation when one already covers the need):
{mcp_catalog}
To use one of these, add it to the tools array as ONLY:
{{"name": "<snake_case_name>", "source": "mcp", "mcp_server": "<server id from the list above>", "mcp_tool": "<tool name from the list above>"}}
Do NOT include "description" or "input_schema" or "implementation" for an MCP tool — they are filled in automatically from the real server, and inventing them yourself will be ignored/overwritten. Only reference a server id and tool name that actually appear in the list above; do not guess or invent one — if nothing in the list fits, write a normal generated tool instead.

Rules:
- persona.traits must be exactly 3 short adjectives describing the agent's working style, grounded in the purpose (e.g. a legal-research agent might get ["meticulous", "formal", "cautious"]; a casual recipe agent might get ["playful", "practical", "warm"]) — avoid generic filler like "helpful" or "efficient" alone
- Design tools that directly serve the stated purpose
- Check the vetted MCP tools list above first for each capability the agent needs — only write a generated Python `implementation` for something no primitive and no vetted MCP tool already covers
- Tool implementations must be self-contained Python snippets
- Do NOT generate a fetch_url, fetch_page, scrape, or HTTP-request tool — use the built-in `fetch_page` primitive instead
- Do NOT generate an image-search or fetch-image tool — use the built-in `search_image` primitive instead
- Do NOT generate an image-generation or image-creation tool — use the built-in `generate_image` primitive instead
{jobsearch_rule}{search_rule}
- Always include a `save_output` tool that writes a final result using os.path.join(TEMP_DIR, filename); the tool must set result = {{'status': 'saved', 'filename': filename, 'path': os.path.join(TEMP_DIR, filename)}}
- Inside every `implementation` string, write Python string/dict literals with SINGLE quotes only (e.g. {{'status': 'saved'}}, not {{"status": "saved"}}). The `implementation` value itself is a double-quoted JSON string — an unescaped double quote inside your Python code ends that JSON string early and breaks the whole response. Single-quoting your Python avoids this entirely; it is not optional style, it is what keeps your own JSON valid.
- The system_prompt you generate MUST instruct the agent that after all tool calls are done it must present the actual findings (listings, data, analysis) in its reply — not list tool names, not say "search complete"
- Search/fetch tools MUST filter results for relevance: only include items where the search keyword appears in the title or description/snippet (case-insensitive). Discard unrelated results returned by the API.
- Return ONLY valid JSON — no markdown fences, no explanation
"""


def _build_user_content(prompt: str, image: str | None, provider: str | None):
    """Mirrors agent_stream.py's per-turn image handling for the one-shot
    bootstrap call: a real image part for Gemini's OpenAI-compatible endpoint,
    or — since the local Ollama fallback model is text-only — a plain-text
    note folded into the prompt instead of a content shape it can't handle."""
    if not image:
        return prompt
    if provider == "ollama":
        return prompt + (
            "\n\n[An image was attached to this purpose, but bootstrap is running "
            "on a local Ollama model, which can't see images. Design the agent from "
            "the text of the purpose above alone.]"
        )
    return [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": image}},
    ]


def _extract_text(response) -> str:
    text = (response.choices[0].message.content or "{}").strip()
    # Strip markdown fences if the model wrapped the JSON anyway
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return text


# Matches a `\uXXXX` unicode escape, or a backslash plus the single character
# after it — used to walk a JSON text one escape-or-literal-backslash at a
# time without re-matching a backslash that was already consumed as part of
# the previous pair (a naive `\\(?!...)` lookahead miscounts runs of `\\`).
_ESCAPE_RE = re.compile(r'\\u[0-9a-fA-F]{4}|\\.', re.DOTALL)
_VALID_ESCAPE_CHARS = set('"\\/bfnrtu')


def _repair_invalid_escapes(text: str) -> str:
    # Local models (Ollama) frequently emit a JSON string containing a raw
    # Windows path or regex pattern (e.g. "C:\Users\...", "\d+", "\s*") with
    # a bare backslash in front of a character that isn't one of JSON's valid
    # escapes ("\", "/", b, f, n, r, t, u) — json.loads rejects the whole
    # payload as "Invalid \escape" even though it's otherwise well-formed.
    # Doubling any such backslash turns it into an escaped literal backslash
    # instead of an error, with no LLM round-trip needed.
    def fix(m: re.Match) -> str:
        s = m.group(0)
        if s.startswith("\\u"):
            return s
        if s[1] in _VALID_ESCAPE_CHARS:
            return s
        return "\\\\" + s[1]

    return _ESCAPE_RE.sub(fix, text)


def _try_parse(text: str) -> tuple[dict | None, json.JSONDecodeError | None]:
    try:
        # strict=False allows raw control characters (literal newlines/tabs)
        # inside JSON string values instead of requiring \n/\t escapes. Local
        # models (Ollama) very often emit multi-line Python `implementation`
        # or system_prompt strings with literal newlines rather than escaping
        # them, which json.loads' default strict mode rejects as "Invalid
        # control character" — even though the payload is otherwise well-formed.
        return json.loads(text, strict=False), None
    except json.JSONDecodeError as e:
        if "Invalid \\escape" in e.msg:
            try:
                return json.loads(_repair_invalid_escapes(text), strict=False), None
            except json.JSONDecodeError:
                pass
        return None, e


# Substrings of json.JSONDecodeError.msg produced when a string value
# contains a raw, unescaped `"` — the classic case is a generated
# `implementation` embedding a Python dict/string literal in double quotes
# (e.g. `result = {"status": "saved", ...}`) with no backslash-escaping, so
# json.loads reads the string as ending at that inner quote and then trips
# over whatever follows. A blind regex "repair" for this was tried and
# rejected: it can't reliably tell a real closing quote from an embedded
# `"key": "value"`-shaped fragment (both look identical to a local scan), so
# a wrong guess could silently splice an unrelated field's content into
# `implementation` with no compile-check to catch it (system_prompt isn't
# Python). Steering the model's own correction retry to fix it properly is
# safer than guessing at already-corrupted text.
_QUOTE_COLLISION_ERRORS = (
    "Expecting ',' delimiter",
    "Expecting property name enclosed in double quotes",
    "Unterminated string",
)


def _json_correction_message(error: json.JSONDecodeError) -> str:
    base = (
        "That was not valid JSON "
        f"(error at char {error.pos}: {error.msg}). "
        "Return ONLY the corrected, complete, valid JSON object — "
        "no markdown fences, no explanation, no truncation."
    )
    if any(marker in error.msg for marker in _QUOTE_COLLISION_ERRORS):
        base += (
            " This error shape usually means a string value (most likely a tool's "
            "`implementation`) contains a raw, unescaped double-quote character — "
            "e.g. it wrote a Python dict/string literal with double quotes, like "
            "{\"status\": \"saved\"}, inside a JSON string that is itself "
            "double-quoted. Fix this by rewriting every Python string/dict literal "
            "inside every `implementation` value using single quotes only (e.g. "
            "{'status': 'saved'}), so no unescaped double quote remains anywhere "
            "inside a JSON string value."
        )
    return base


def _tool_syntax_errors(config: dict) -> list[tuple[str, SyntaxError]]:
    """Bootstrap only guarantees the config is valid JSON — the `implementation`
    field is just a string as far as JSON is concerned, so a model can hand
    back perfectly valid JSON containing broken Python (a truncated dict
    literal, mismatched braces from bad escaping, etc.). That only used to
    surface later as a `Tool execution error` the first time the tool was
    actually called. Compile-checking every implementation here catches it
    at bootstrap time instead."""
    errors: list[tuple[str, SyntaxError]] = []
    for tool in config.get("tools", []):
        if not isinstance(tool, dict):
            continue
        impl = tool.get("implementation")
        if not isinstance(impl, str):
            continue
        try:
            compile(impl, "<tool>", "exec")
        except SyntaxError as e:
            errors.append((tool.get("name", "<unnamed>"), e))
    return errors


def _describe_tool_errors(errors: list[tuple[str, SyntaxError]]) -> str:
    return "; ".join(f"tool '{name}': {e.msg} at line {e.lineno}" for name, e in errors)


class _UndefinedCallError:
    """Mimics enough of SyntaxError's shape (.msg/.lineno) to reuse
    _describe_tool_errors and the retry/drop flow in _tool_syntax_errors'
    caller, for a bug _tool_syntax_errors itself can't catch: valid Python
    that compiles fine but calls an undefined name at runtime."""
    def __init__(self, msg: str):
        self.msg = msg
        self.lineno = "?"


def _forbidden_call_errors(config: dict, forbidden_names: set[str]) -> list[tuple[str, _UndefinedCallError]]:
    """A generated tool's `implementation` calling a primitive
    (search_jobs/fetch_page/search_image) or a vetted MCP tool name (e.g.
    tavily_search) as if it were a pre-injected Python function compiles
    fine — it's valid Python — but is a guaranteed NameError the moment
    tools.py actually execs it, since the sandbox never defines those names.
    The bootstrap prompt already tells the model not to do this; this is the
    same "catch the bug at bootstrap time, not first live call" safety net
    _tool_syntax_errors provides for outright syntax errors, extended to
    this specific, deterministically-detectable mistake instead of trusting
    the prompt alone.

    Also catches the attribute-qualified variant of the same mistake — live
    traffic surfaced a generated implementation calling `tools.search_image(...)`,
    imagining the primitive lives as a method on some pre-injected `tools`
    module (presumably pattern-matching this project's own tools.py, visible
    to the model via bootstrap-grounding few-shot examples). No module named
    `tools` — or anything else — is injected into the exec() sandbox, so this
    fails with `NameError: name 'tools' is not defined` at the same point a
    bare `search_image(...)` call would fail with a NameError on the name
    itself. The regex now matches the forbidden name whether called bare or
    as `<anything>.name(...)`, since both resolve to the same "not a real
    symbol in this sandbox" bug."""
    errors: list[tuple[str, _UndefinedCallError]] = []
    for tool in config.get("tools", []):
        if not isinstance(tool, dict) or tool.get("source") == "mcp":
            continue
        impl = tool.get("implementation")
        if not isinstance(impl, str):
            continue
        for name in forbidden_names:
            if re.search(rf'(?:\b\w+\.)?\b{re.escape(name)}\s*\(', impl):
                errors.append((
                    tool.get("name", "<unnamed>"),
                    _UndefinedCallError(
                        f"implementation calls `{name}(...)` (bare or as an attribute, "
                        f"e.g. `tools.{name}(...)`) as if it were a pre-injected Python "
                        "function, but that name is a primitive/vetted-MCP tool, not "
                        "something defined inside a generated implementation string"
                    ),
                ))
                break
    return errors


_LOCAL_ENDPOINT_PATTERN = re.compile(r"(https?://)?(127\.0\.0\.1|localhost)(:\d+)?", re.IGNORECASE)


def _local_endpoint_errors(config: dict) -> list[tuple[str, _UndefinedCallError]]:
    """A second, distinct variant of the bug _forbidden_call_errors catches:
    live traffic surfaced a generated tool whose `implementation` didn't call
    `tavily_search(...)` as a bare function (which the regex above would have
    caught) but instead POSTed to a hallucinated local tool-invocation
    service — `requests.post("http://127.0.0.1:9696/tool/tavily_search", ...)`
    — imagining an HTTP proxy in front of vetted/primitive tools that doesn't
    exist. Nothing in this sandbox ever listens on 127.0.0.1/localhost for a
    generated tool to call, so any implementation referencing one is a
    guaranteed connection-refused failure at execution time, just like a bare
    forbidden-name call is a guaranteed NameError — same bug class, same
    one-retry/then-drop treatment."""
    errors: list[tuple[str, _UndefinedCallError]] = []
    for tool in config.get("tools", []):
        if not isinstance(tool, dict) or tool.get("source") == "mcp":
            continue
        impl = tool.get("implementation")
        if not isinstance(impl, str):
            continue
        if _LOCAL_ENDPOINT_PATTERN.search(impl):
            errors.append((
                tool.get("name", "<unnamed>"),
                _UndefinedCallError(
                    "implementation makes an HTTP request to 127.0.0.1/localhost — "
                    "there is no local tool-invocation service for generated code to "
                    "call; call a real external API directly, or for a primitive/"
                    "vetted-MCP capability don't write an implementation at all"
                ),
            ))
    return errors


# Mirrors tools.py's execute_tool() namespace exactly — keep in sync with
# that function if the sandbox's injected names or allowed builtins change.
_SANDBOX_BUILTIN_NAMES = frozenset({
    "print", "len", "range", "enumerate", "zip", "map", "filter",
    "sorted", "reversed", "list", "dict", "set", "tuple", "str",
    "int", "float", "bool", "type", "isinstance", "hasattr", "getattr",
    "min", "max", "sum", "abs", "round", "repr", "format",
    "any", "all", "next", "iter", "hash", "id",
    "open", "__import__", "dir", "vars", "globals", "locals", "callable",
    "Exception", "ValueError", "KeyError", "TypeError", "IOError",
    "StopIteration", "RuntimeError", "IndexError", "AttributeError",
})
_SANDBOX_INJECTED_NAMES = frozenset({
    "inputs", "input_data", "input", "requests", "json", "os", "re", "math",
    "datetime", "collections", "urllib", "TEMP_DIR", "search_jobs",
    "fetch_page", "result",
})


def _locally_bound_names(tree: ast.AST) -> set[str]:
    """Every name the implementation defines for itself — via def/class,
    import, assignment (including walrus/for/with/comprehension targets,
    all of which the Python AST already represents as a Name in Store
    context), function parameters, or an except-as/global/nonlocal clause.
    Anything in this set is legitimately callable even though it isn't part
    of the sandbox itself."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Import):
            names.update((a.asname or a.name).split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.update(a.asname or a.name for a in node.names)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            names.add(node.id)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
    return names


def _undefined_call_errors(
    config: dict, already_flagged_names: "set[str] | frozenset[str]" = frozenset()
) -> list[tuple[str, _UndefinedCallError]]:
    """A generalization of _forbidden_call_errors: rather than checking
    against a fixed, known list of primitive/MCP names, this statically
    parses each implementation and flags ANY bare `name(...)` call where
    `name` is neither something the sandbox actually injects
    (_SANDBOX_INJECTED_NAMES/_SANDBOX_BUILTIN_NAMES), one of the tool's own
    declared input properties, nor something the implementation defines for
    itself (_locally_bound_names). Live traffic surfaced a model calling
    `tas_search(...)` — not `search_jobs`, `fetch_page`, or any real vetted
    MCP tool name, just an invented helper that was never defined anywhere —
    which no fixed forbidden-name list could have anticipated. This is a
    guaranteed NameError the moment tools.py execs it, exactly like the bugs
    _forbidden_call_errors catches, so it feeds the same one-retry/then-drop
    flow. `already_flagged_names` lets callers skip names
    _forbidden_call_errors already reported with a more specific message,
    so the same bug doesn't produce two overlapping error entries for one
    tool."""
    errors: list[tuple[str, _UndefinedCallError]] = []
    for tool in config.get("tools", []):
        if not isinstance(tool, dict) or tool.get("source") == "mcp":
            continue
        impl = tool.get("implementation")
        if not isinstance(impl, str):
            continue
        try:
            tree = ast.parse(impl)
        except SyntaxError:
            continue  # _tool_syntax_errors already reports this
        schema = tool.get("input_schema")
        props = schema.get("properties") if isinstance(schema, dict) else None
        input_names = set(props.keys()) if isinstance(props, dict) else set()
        known = (
            _SANDBOX_BUILTIN_NAMES | _SANDBOX_INJECTED_NAMES | input_names
            | already_flagged_names | _locally_bound_names(tree)
        )
        flagged: set[str] = set()
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            name = node.func.id
            if name in known or name in flagged:
                continue
            flagged.add(name)
            errors.append((
                tool.get("name", "<unnamed>"),
                _UndefinedCallError(
                    f"implementation calls `{name}(...)`, but that name is never "
                    "defined anywhere in the implementation (no def/import/"
                    "assignment) and is not one of the values the sandbox actually "
                    "provides (inputs, requests, json, os, re, math, datetime, "
                    "collections, urllib, TEMP_DIR, search_jobs, fetch_page, or the "
                    "tool's own declared input properties) — this is a guaranteed "
                    "NameError the first time the tool runs"
                ),
            ))
    return errors


def _fake_save_output_errors(config: dict) -> list[tuple[str, _UndefinedCallError]]:
    """The bootstrap prompt mandates a `save_output` tool that writes to disk
    via open(os.path.join(TEMP_DIR, filename), 'w') before returning
    {'status': 'saved', 'filename': ..., 'path': ...}. A live report
    (`waterskier_findings.md` showing "Could not load file.") traced back to
    a generated `save_output` implementation that built and returned that
    success dict directly, with no open()/write() call anywhere — so the
    tool reported success with a filename/path that GET /file/<filename>
    then 404s on, since nothing was ever written to TEMP_DIR.

    This is a distinct bug class from _forbidden_call_errors/
    _local_endpoint_errors: those are guaranteed to raise at execution time
    (NameError, connection refused), which is what makes them exec()-able and
    therefore something a live traffic report would have surfaced as a
    crash. A fabricated result dict never raises anything — the sandbox
    happily execs code that skips the write and just returns the dict — so
    it can only be caught structurally, at bootstrap time, before the fake
    success is ever trusted. Same one-retry/then-drop treatment as the other
    checks regardless."""
    errors: list[tuple[str, _UndefinedCallError]] = []
    for tool in config.get("tools", []):
        if not isinstance(tool, dict) or tool.get("source") == "mcp":
            continue
        if tool.get("name") != "save_output":
            continue
        impl = tool.get("implementation")
        if not isinstance(impl, str):
            continue
        if "open(" not in impl:
            errors.append((
                "save_output",
                _UndefinedCallError(
                    "implementation never calls open(...) to actually write a file — "
                    "it must write via open(os.path.join(TEMP_DIR, filename), 'w') "
                    "before setting result = {'status': 'saved', ...}, otherwise the "
                    "reported filename/path doesn't exist and GET /file/<filename> "
                    "will 404"
                ),
            ))
    return errors


def _format_mcp_catalog(catalog: list[dict]) -> str:
    """Renders mcp_client.catalog_summary() for the bootstrap prompt. Empty
    catalog (no vetted server reachable in this environment) renders as an
    explicit "none available" line rather than an empty gap in the prompt,
    so the model doesn't fabricate one anyway."""
    if not catalog:
        return "(none currently available)"
    return "\n".join(
        f'- server "{c["server_id"]}", tool "{c["tool_name"]}": {c["description"]}'
        for c in catalog
    )


def _resolve_mcp_tools(config: dict) -> None:
    """For every tool the model tagged "source": "mcp", replace whatever it
    wrote for name/description/input_schema with the REAL schema from the
    vetted server (same "trust the live schema, not the model's guess"
    lesson as ComfyUI's node_schemas) and drop any implementation it may
    have hallucinated alongside it. A (mcp_server, mcp_tool) pair that
    doesn't match anything in the real catalog is dropped entirely — same
    "drop the offending tool" behaviour _tool_syntax_errors already uses for
    broken generated Python, just for a hallucinated MCP reference instead."""
    catalog = {(c["server_id"], c["tool_name"]): c for c in mcp_client.catalog_summary()}
    resolved = []
    for tool in config.get("tools", []):
        if not isinstance(tool, dict):
            continue
        if tool.get("source") == "mcp":
            real = catalog.get((tool.get("mcp_server"), tool.get("mcp_tool")))
            if real is None:
                logger.info(
                    "Dropping hallucinated MCP tool reference: server=%s tool=%s",
                    tool.get("mcp_server"), tool.get("mcp_tool"),
                )
                continue
            tool["name"] = tool.get("name") or real["tool_name"]
            tool["description"] = real["description"]
            tool["input_schema"] = real["input_schema"]
            tool.pop("implementation", None)
        resolved.append(tool)
    config["tools"] = resolved


def _format_fewshot(entries: list[dict]) -> str:
    """Renders bootstrap_memory.retrieve_similar() results as a few-shot
    block for the prompt. Empty list (no history yet, or embeddings
    unavailable) renders as "" so the prompt is byte-identical to before
    this feature existed — that's the cold-start / degraded path."""
    if not entries:
        return ""
    blocks = []
    for entry in entries:
        persona = entry.get("persona") or {}
        tool_lines = "\n".join(
            f'  - {t.get("name")}: {t.get("description")}'
            for t in entry.get("tool_descriptions", []) if t.get("name")
        ) or "  (none)"
        persona_line = (
            f'{persona.get("name")} ({", ".join(persona.get("traits", []))})'
            if persona.get("name") else "(none)"
        )
        blocks.append(
            f'Purpose: "{entry.get("purpose")}"\n'
            f'Persona: {persona_line}\n'
            f'Tools:\n{tool_lines}'
        )
    joined = "\n\n".join(blocks)
    return (
        "\nSimilar past agents that worked well for related purposes — use these as "
        "reference for what a well-scoped tool set looks like, but design tools "
        f"specific to THIS purpose rather than copying them verbatim:\n\n{joined}\n"
    )


def _normalize_persona(config: dict) -> None:
    """Best-effort cleanup of the model-generated `persona` field. A model
    can omit it, mistype a field, or nest it wrong — rather than let a bad
    shape reach the frontend (which does `persona.traits.join(...)`), drop
    the whole field on any defect so callers just fall back to the random
    surname placeholder, same as if the model had never returned one."""
    persona = config.get("persona")
    if not isinstance(persona, dict):
        config.pop("persona", None)
        return
    name = persona.get("name")
    traits = persona.get("traits")
    rationale = persona.get("rationale")
    valid = (
        isinstance(name, str) and name.strip()
        and isinstance(traits, list) and all(isinstance(t, str) for t in traits)
        and isinstance(rationale, str)
    )
    if valid:
        config["persona"] = {"name": name.strip(), "traits": traits, "rationale": rationale}
    else:
        config.pop("persona", None)


def _build_prompt(
    purpose: str, provider: str | None, is_worker: bool, agent_type: str | None = None,
    has_image: bool = False,
) -> tuple[str, int]:
    """Grounds the bootstrap prompt in real data (CLAUDE.md RAG priority 5 +
    MCP priority 6): past similar bootstraps as few-shot examples, and the
    real vetted MCP tool catalog. Returns (prompt, fewshot_count) — the count
    is surfaced as a status event by the streaming variant.

    `has_image` just controls whether the prompt text tells the model an
    image is attached (`_build_user_content` below is what actually attaches
    it) — treated like an extra keyword: something to let inform the
    persona/system_prompt/tools, not merely acknowledge."""
    fewshot_entries = bootstrap_memory.retrieve_similar(purpose, provider, is_worker, agent_type=agent_type)
    mcp_catalog = mcp_client.catalog_summary()
    _has_web_search_mcp = any(c["server_id"] == "search" for c in mcp_catalog)
    # search_jobs is only ever wired up at runtime for a job_search agent
    # (agent_stream.run_agent_stream gates it by AgentConfig.template) — an
    # unset agent_type (e.g. a delegated worker whose parent isn't job_search)
    # is treated as "not job search" so bootstrap doesn't tell a general/
    # research agent to lean on a tool it will never actually have.
    _image_primitive = (
        "- `search_image` — finds one real, freely-licensed illustrative image for a "
        "topic via Wikipedia (no key required, not scraping). Takes `query` (string, "
        "the topic). Returns {image_url, title, page_url, attribution} on success, or "
        "{error} if nothing matched or the topic has no image. An agent's own written "
        "analysis is always the primary output; this is supplementary illustration "
        "only — instruct the agent to call it sparingly (only when a picture would "
        "genuinely help) and to embed the real `image_url` it gets back as a markdown "
        "image, never to fabricate one.\n"
    )
    _image_gen_primitive = (
        "- `generate_image` — creates a brand-new image from a text description, "
        "for when no real photo exists to find (use `search_image` for that "
        "instead). Takes `prompt` (string, a clear description of the image to "
        "generate). Tries Gemini's image model first, then automatically falls "
        "back to Hugging Face's free-tier Inference API if Gemini isn't "
        "configured or fails — so it's available even with no GEMINI_API_KEY "
        "set, as long as HF_API_TOKEN is configured. Returns {image_url, "
        "provider} on success (embed the url directly, "
        "no download/storage step needed) or {error} only if both attempts "
        "fail. An agent's own written analysis is always the primary output; "
        "instruct the agent to call it sparingly (only when generating a new "
        "image is genuinely the right way to help) and to embed the real "
        "`image_url` it gets back as a markdown image, never to fabricate one.\n"
    )
    if agent_type == "job_search":
        primitives_block = (
            "Four primitive tools are pre-built and always available to the agent — "
            "do NOT include any of them in the tools array you generate:\n\n"
            "- `fetch_page` — takes a `url` (string), returns "
            "{status_code, url, content, char_count, truncated, listing_count} where "
            "`content` is clean text with all HTML, scripts, and SVG stripped. Use for "
            "company pages, news, or any general URL.\n"
            "- `search_jobs` — real job search via the Adzuna API (not scraping). Takes "
            "`what` (required, job title/keywords), `where` (optional location), "
            "`country` (optional, default \"au\"), `results_per_page` (optional, default 20), "
            "`page` (optional, default 1), `distance_km` (optional radius around `where`, "
            "km — defaults to 15 automatically whenever `where` is set and this is omitted, "
            "so a location is never left unbounded). "
            "Returns {status_code, total_count, returned, mean_salary, listings: "
            "[{title, company, location, salary_min, salary_max, redirect_url, description, "
            "created, contract_type, category}]}.\n"
            f"{_image_primitive}"
            f"{_image_gen_primitive}\n"
            "Instruct the agent to call these directly rather than reinventing them."
        )
        jobsearch_rule = (
            "- Do NOT generate any tool that fetches or scrapes job listings, salary data, "
            "or job boards (SEEK, Indeed, LinkedIn, etc.) via `fetch_page` or raw HTTP "
            "requests — those sites block this server's IP with a 403 regardless of headers. "
            "For ANY job search, job listing, or salary-research purpose, the system_prompt "
            "MUST instruct the agent to call the built-in `search_jobs` primitive instead.\n"
        )
        jobsearch_pronoun_suffix = " (or `search_jobs` for job data)"
    else:
        primitives_block = (
            "Three primitive tools are pre-built and always available to the agent — "
            "do NOT include any of them in the tools array you generate:\n\n"
            "- `fetch_page` — takes a `url` (string), returns "
            "{status_code, url, content, char_count, truncated, listing_count} where "
            "`content` is clean text with all HTML, scripts, and SVG stripped. Use for "
            "company pages, news, or any general URL.\n"
            f"{_image_primitive}"
            f"{_image_gen_primitive}\n"
            "Instruct the agent to call these directly rather than reinventing them. This "
            "agent has no job-search tool — do not instruct it to search job listings or "
            "salary data; that capability is reserved for job-search agents only."
        )
        jobsearch_rule = ""
        jobsearch_pronoun_suffix = ""
    # This used to be a hardcoded "there is no search engine available" rule,
    # written before any vetted MCP search server existed. Left as a flat
    # constant, it silently went stale the moment mcp_registry.py added the
    # Tavily "search" server: the model was being told a real, catalog-listed
    # tool didn't exist, so it kept "obeying" by writing fetch_page calls
    # against guessed/hallucinated URLs (and describing a nonexistent "Google
    # search" step in its plan) instead of picking the vetted tool. Now
    # conditional on whether "search" is actually reachable right now.
    if _has_web_search_mcp:
        search_rule = (
            "- Do NOT generate a web_search, search_web, google_search, or any other "
            "internet-search tool of your own, and do NOT call `fetch_page` with a "
            "guessed or hardcoded URL when the actual need is \"find pages about X\" "
            "rather than \"fetch this exact URL I already have\" — use the vetted "
            "`tavily_search` MCP tool (server \"search\" in the list above, added via "
            "the `\"source\": \"mcp\"` shape) for that instead"
            f"{jobsearch_pronoun_suffix}\n"
        )
    else:
        search_rule = (
            "- Do NOT generate a web_search, search_web, google_search, or any "
            "internet-search tool — there is no search engine available; agents must "
            f"use `fetch_page` with direct URLs{jobsearch_pronoun_suffix}\n"
        )
    image_note = (
        "\nAn image was also attached alongside this purpose (sent as a "
        "separate image part on this same message, not shown here as text) — "
        "look at it and let what it actually shows inform the persona, "
        "system_prompt, and tools you design, the same way a keyword would, "
        "rather than only acknowledging that an image exists.\n"
    ) if has_image else ""
    prompt = _BOOTSTRAP_PROMPT.format(
        purpose=purpose,
        image_note=image_note,
        fewshot=_format_fewshot(fewshot_entries),
        mcp_catalog=_format_mcp_catalog(mcp_catalog),
        primitives_block=primitives_block,
        jobsearch_rule=jobsearch_rule,
        search_rule=search_rule,
    )
    return prompt, len(fewshot_entries)


def generate_agent_config(
    purpose: str, provider: str | None = None, model: str | None = None, is_worker: bool = False,
    agent_type: str | None = None, image: str | None = None,
) -> tuple[dict, int]:
    """Returns (config, fewshot_count) — the count is how many past similar
    bootstraps grounded this one (0 if none), surfaced by callers that want
    to show whether RAG grounding was used (e.g. orchestrator.run_worker).

    `image` (a base64 data URL, same shape as a chat turn's attachment) lets
    the purpose be illustrated rather than typed out in full — see
    _build_user_content."""
    prompt, fewshot_count = _build_prompt(purpose, provider, is_worker, agent_type, has_image=bool(image))
    user_content = _build_user_content(prompt, image, provider)
    response = create_chat_completion(
        provider=provider,
        model=model,
        max_tokens=16000,
        messages=[{"role": "user", "content": user_content}],
    )
    text = _extract_text(response)
    config, error = _try_parse(text)

    # One correction-prompt retry on malformed JSON — same pattern as jobfit's
    # appraisal retry and ChattyPrayers' SVG retry. Smaller local models are
    # far more likely to mangle a payload this size than Gemini, so this
    # matters a lot more for provider="ollama" than for the cloud default.
    if config is None:
        # _try_parse always returns error alongside a None config — this
        # assert just tells Pylance what that invariant already guarantees
        # at runtime (the tuple's two halves are independently optional to
        # the type checker, even though exactly one is ever None).
        assert error is not None
        correction_response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=16000,
            messages=[
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": text},
                {"role": "user", "content": _json_correction_message(error)},
            ],
        )
        text = _extract_text(correction_response)
        config, error = _try_parse(text)

    if config is None:
        assert error is not None
        logger.warning(
            "Bootstrap JSON parse failed after retry (error at char %d: %s). Raw response:\n%s",
            error.pos, error.msg, text,
        )
        raise ValueError(
            f"Bootstrap response was not valid JSON after one retry. "
            f"Error at char {error.pos}: {error.msg}. "
            f"Try a simpler purpose description, or a different model if running local-only."
        )

    # Second validation pass: valid JSON doesn't mean valid Python inside the
    # `implementation` strings. One correction retry, same shape as the JSON
    # retry above; if it's still broken, drop just the offending tool(s)
    # rather than failing the whole agent over one bad tool. Bundles four
    # error classes: outright syntax errors; valid-but-doomed Python that
    # calls a primitive/vetted-MCP tool name as a bare function (guaranteed
    # NameError the first time tools.py execs it — see _forbidden_call_errors);
    # valid-but-doomed Python that instead POSTs/GETs a hallucinated
    # 127.0.0.1/localhost "tool service" (guaranteed connection-refused — see
    # _local_endpoint_errors); and a `save_output` tool that fabricates a
    # {'status': 'saved', ...} result without ever calling open() to actually
    # write the file (see _fake_save_output_errors).
    forbidden_names = {"search_jobs", "fetch_page", "search_image", "generate_image"} | {
        c["tool_name"] for c in mcp_client.catalog_summary()
    }
    tool_errors = (
        _tool_syntax_errors(config)
        + _forbidden_call_errors(config, forbidden_names)
        + _undefined_call_errors(config, forbidden_names)
        + _local_endpoint_errors(config)
        + _fake_save_output_errors(config)
    )
    if tool_errors:
        correction_response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=16000,
            messages=[
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": text},
                {"role": "user", "content": (
                    "The JSON parsed, but these tools' `implementation` strings are not "
                    f"valid: {_describe_tool_errors(tool_errors)}. "
                    "Return ONLY the corrected, complete, valid JSON object with fixed "
                    "implementations — no markdown fences, no explanation, no truncation."
                )},
            ],
        )
        text = _extract_text(correction_response)
        retried_config, retry_error = _try_parse(text)
        if retried_config is not None:
            config = retried_config
            tool_errors = (
                _tool_syntax_errors(config)
                + _forbidden_call_errors(config, forbidden_names)
                + _undefined_call_errors(config, forbidden_names)
                + _local_endpoint_errors(config)
                + _fake_save_output_errors(config)
            )

    if tool_errors:
        broken = {name for name, _ in tool_errors}
        config["tools"] = [
            t for t in config.get("tools", [])
            if not isinstance(t, dict) or t.get("name") not in broken
        ]

    _resolve_mcp_tools(config)
    _normalize_persona(config)
    config["purpose"] = purpose
    # Carried in AgentConfig so every subsequent /agent turn in this session
    # reuses the same provider/model choice made on the Setup screen.
    config["provider"] = provider
    config["ollama_model"] = model
    # Stable identity for this generated config, independent of its
    # (mutable) name/description — lets agent_registry.publish() recognize
    # "this is the same agent being re-published" and update the existing
    # MCP-tool entry in place instead of creating a duplicate.
    config["agent_config_id"] = uuid.uuid4().hex
    bootstrap_memory.record(purpose, config, provider, is_worker, agent_type=agent_type)
    return config, fewshot_count


_TOOL_NAME_RE = re.compile(r'"name"\s*:\s*"([^"]+)"')
_SYSTEM_PROMPT_KEY_RE = re.compile(r'"system_prompt"\s*:\s*"')
_PERSONA_KEY_RE = re.compile(r'"persona"\s*:\s*\{')
_TOOLS_KEY_RE = re.compile(r'"tools"\s*:\s*\[')


def _model_event(meta: dict) -> dict:
    """Turn a create_chat_completion `_meta` dict into a {"type": "model", ...}
    stream event — reported whether the call succeeded or every provider
    failed, so the UI can show which model(s) were actually tried."""
    return {"type": "model", "used": meta.get("used"), "failed": meta.get("failed", [])}


def generate_agent_config_stream(
    purpose: str, provider: str | None = None, model: str | None = None, is_worker: bool = False,
    agent_type: str | None = None, image: str | None = None,
):
    """
    Streaming counterpart to generate_agent_config, used only by server.py's
    /bootstrap (not the Lambda handler, which has no streaming response type
    to use it with). Bootstrap is a single LLM call with nothing to report
    progress on otherwise — this streams the raw completion token-by-token
    and heuristically scans the growing buffer for landmarks (the
    system_prompt key opening, each tool's "name" field appearing) so the UI
    has *something* real to show instead of a static "~10 seconds" message.
    Matters most for local Ollama models, which can take far longer than that.

    `image` — see generate_agent_config's docstring; same base64 data URL
    shape, same _build_user_content handling.

    Event shapes:
      {"type": "status", "message": "..."}
      {"type": "tool",   "name": "..."}
      {"type": "done",   "config": {...}}
      {"type": "error",  "message": "..."}
    """
    yield {"type": "status", "message": "Thinking about your purpose…"}

    prompt, fewshot_count = _build_prompt(purpose, provider, is_worker, agent_type, has_image=bool(image))
    user_content = _build_user_content(prompt, image, provider)
    if fewshot_count:
        yield {"type": "status", "message": f"Found {fewshot_count} similar past agent(s) — reusing what worked…"}

    seen_tools: set[str] = set()
    seen_persona = False
    seen_system_prompt = False
    tools_start: int | None = None
    buffer = ""

    meta: dict = {}
    try:
        stream = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=16000,
            stream=True,
            _meta=meta,
            messages=[{"role": "user", "content": user_content}],
        )
        yield _model_event(meta)
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if not delta:
                continue
            buffer += delta

            if not seen_persona and _PERSONA_KEY_RE.search(buffer):
                seen_persona = True
                yield {"type": "status", "message": "Choosing a personality…"}

            if not seen_system_prompt and _SYSTEM_PROMPT_KEY_RE.search(buffer):
                seen_system_prompt = True
                yield {"type": "status", "message": "Writing system prompt…"}

            # Tool names are only scanned for past the "tools": [ marker —
            # persona also has a "name" field, and matching it here would
            # misreport the persona's name as a tool.
            if tools_start is None:
                tools_match = _TOOLS_KEY_RE.search(buffer)
                if tools_match:
                    tools_start = tools_match.end()
            if tools_start is not None:
                for m in _TOOL_NAME_RE.finditer(buffer, tools_start):
                    name = m.group(1)
                    if name not in seen_tools:
                        seen_tools.add(name)
                        yield {"type": "tool", "name": name}
    except Exception as e:
        yield _model_event(meta)
        yield {"type": "error", "message": f"Bootstrap failed: {e}"}
        return

    text = buffer.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    config, error = _try_parse(text)

    # Same one-shot correction retry as generate_agent_config, just not
    # streamed itself — a malformed response is the rare path, not worth
    # re-deriving token-level progress for.
    if config is None:
        # See the assert in generate_agent_config for why this is safe:
        # _try_parse never returns a None config alongside a None error.
        assert error is not None
        yield {"type": "status", "message": "Fixing malformed response…"}
        correction_meta: dict = {}
        try:
            correction_response = create_chat_completion(
                provider=provider,
                model=model,
                max_tokens=16000,
                _meta=correction_meta,
                messages=[
                    {"role": "user", "content": user_content},
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": _json_correction_message(error)},
                ],
            )
            yield _model_event(correction_meta)
            text = _extract_text(correction_response)
            config, error = _try_parse(text)
        except Exception as e:
            yield _model_event(correction_meta)
            yield {"type": "error", "message": f"Correction retry failed: {e}"}
            return

    if config is None:
        assert error is not None
        logger.warning(
            "Bootstrap JSON parse failed after retry (error at char %d: %s). Raw response:\n%s",
            error.pos, error.msg, text,
        )
        yield {"type": "error", "message": (
            f"Bootstrap response was not valid JSON after one retry. "
            f"Error at char {error.pos}: {error.msg}. "
            f"Try a simpler purpose description, or a different model if running local-only."
        )}
        return

    # Same compile-check + one correction retry as generate_agent_config —
    # see _tool_syntax_errors for why JSON validity alone isn't enough,
    # _forbidden_call_errors for a generated tool calling a primitive/
    # vetted-MCP tool name as a bare function (valid Python, guaranteed
    # NameError at execution time), _local_endpoint_errors for the same
    # bug via a hallucinated 127.0.0.1/localhost HTTP call instead, and
    # _fake_save_output_errors for a save_output tool that fabricates a
    # success result without ever writing the file.
    forbidden_names = {"search_jobs", "fetch_page", "search_image", "generate_image"} | {
        c["tool_name"] for c in mcp_client.catalog_summary()
    }
    tool_errors = (
        _tool_syntax_errors(config)
        + _forbidden_call_errors(config, forbidden_names)
        + _undefined_call_errors(config, forbidden_names)
        + _local_endpoint_errors(config)
        + _fake_save_output_errors(config)
    )
    if tool_errors:
        yield {"type": "status", "message": "Fixing broken tool code…"}
        tool_fix_meta: dict = {}
        try:
            correction_response = create_chat_completion(
                provider=provider,
                model=model,
                max_tokens=16000,
                _meta=tool_fix_meta,
                messages=[
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": (
                        "The JSON parsed, but these tools' `implementation` strings are not "
                        f"valid: {_describe_tool_errors(tool_errors)}. "
                        "Return ONLY the corrected, complete, valid JSON object with fixed "
                        "implementations — no markdown fences, no explanation, no truncation."
                    )},
                ],
            )
            yield _model_event(tool_fix_meta)
            text = _extract_text(correction_response)
            retried_config, _ = _try_parse(text)
            if retried_config is not None:
                config = retried_config
                tool_errors = (
                    _tool_syntax_errors(config)
                    + _forbidden_call_errors(config, forbidden_names)
                    + _undefined_call_errors(config, forbidden_names)
                    + _local_endpoint_errors(config)
                    + _fake_save_output_errors(config)
                )
        except Exception as e:
            yield _model_event(tool_fix_meta)
            yield {"type": "error", "message": f"Tool-code correction retry failed: {e}"}
            return

    dropped_tool_names: list[str] = []
    if tool_errors:
        broken = {name for name, _ in tool_errors}
        dropped_tool_names = sorted(broken)
        config["tools"] = [
            t for t in config.get("tools", [])
            if not isinstance(t, dict) or t.get("name") not in broken
        ]

    _resolve_mcp_tools(config)
    _normalize_persona(config)
    config["purpose"] = purpose
    config["provider"] = provider
    config["ollama_model"] = model
    # See generate_agent_config's identical assignment above for why this
    # exists — a stable id agent_registry.publish() can key off of.
    config["agent_config_id"] = uuid.uuid4().hex

    try:
        for eval_result in eval_checks.check_bootstrap(
            config, purpose, provider, model, dropped_tool_names=dropped_tool_names,
        ):
            eval_log.record(eval_result)
            yield {"type": "eval_result", **eval_result}
    except Exception as e:
        logger.info("bootstrap eval checks skipped: %s", e)

    bootstrap_memory.record(purpose, config, provider, is_worker, agent_type=agent_type)
    yield {"type": "done", "config": config}
