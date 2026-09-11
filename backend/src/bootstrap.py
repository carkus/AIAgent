import json
import logging
import re
from llm_client import create_chat_completion
import bootstrap_memory
import mcp_client

logger = logging.getLogger(__name__)

_BOOTSTRAP_PROMPT = """\
You are a meta-agent configurator. A user wants a custom AI agent for the following purpose:

<purpose>
{purpose}
</purpose>
{fewshot}
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

Two primitive tools are pre-built and always available to the agent — do NOT include either in the tools array you generate:

- `fetch_page` — takes a `url` (string), returns `{{status_code, url, content, char_count, truncated, listing_count}}` where `content` is clean text with all HTML, scripts, and SVG stripped. Use for company pages, news, or any general URL.
- `search_jobs` — real job search via the Adzuna API (not scraping). Takes `what` (required, job title/keywords), `where` (optional location), `country` (optional, default "au"), `results_per_page` (optional, default 20), `page` (optional, default 1). Returns `{{status_code, total_count, returned, mean_salary, listings: [{{title, company, location, salary_min, salary_max, redirect_url, description, created, contract_type, category}}]}}`.

Instruct the agent to call these directly rather than reinventing them.

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
- Do NOT generate any tool that fetches or scrapes job listings, salary data, or job boards (SEEK, Indeed, LinkedIn, etc.) via `fetch_page` or raw HTTP requests — those sites block this server's IP with a 403 regardless of headers. For ANY job search, job listing, or salary-research purpose, the system_prompt MUST instruct the agent to call the built-in `search_jobs` primitive instead.
- Do NOT generate a web_search, search_web, google_search, or any internet-search tool — there is no search engine available; agents must use `fetch_page` with direct URLs (or `search_jobs` for job data)
- Always include a `save_output` tool that writes a final result using os.path.join(TEMP_DIR, filename); the tool must set result = {{"status": "saved", "filename": filename, "path": os.path.join(TEMP_DIR, filename)}}
- The system_prompt you generate MUST instruct the agent that after all tool calls are done it must present the actual findings (listings, data, analysis) in its reply — not list tool names, not say "search complete"
- Search/fetch tools MUST filter results for relevance: only include items where the search keyword appears in the title or description/snippet (case-insensitive). Discard unrelated results returned by the API.
- Return ONLY valid JSON — no markdown fences, no explanation
"""


def _extract_text(response) -> str:
    text = (response.choices[0].message.content or "{}").strip()
    # Strip markdown fences if the model wrapped the JSON anyway
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return text


def _try_parse(text: str) -> tuple[dict | None, json.JSONDecodeError | None]:
    try:
        return json.loads(text), None
    except json.JSONDecodeError as e:
        return None, e


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


def _build_prompt(purpose: str, provider: str | None, is_worker: bool) -> tuple[str, int]:
    """Grounds the bootstrap prompt in real data (CLAUDE.md RAG priority 5 +
    MCP priority 6): past similar bootstraps as few-shot examples, and the
    real vetted MCP tool catalog. Returns (prompt, fewshot_count) — the count
    is surfaced as a status event by the streaming variant."""
    fewshot_entries = bootstrap_memory.retrieve_similar(purpose, provider, is_worker)
    mcp_catalog = mcp_client.catalog_summary()
    prompt = _BOOTSTRAP_PROMPT.format(
        purpose=purpose,
        fewshot=_format_fewshot(fewshot_entries),
        mcp_catalog=_format_mcp_catalog(mcp_catalog),
    )
    return prompt, len(fewshot_entries)


def generate_agent_config(
    purpose: str, provider: str | None = None, model: str | None = None, is_worker: bool = False
) -> dict:
    prompt, _ = _build_prompt(purpose, provider, is_worker)
    response = create_chat_completion(
        provider=provider,
        model=model,
        max_tokens=16000,
        messages=[{"role": "user", "content": prompt}],
    )
    text = _extract_text(response)
    config, error = _try_parse(text)

    # One correction-prompt retry on malformed JSON — same pattern as jobfit's
    # appraisal retry and ChattyPrayers' SVG retry. Smaller local models are
    # far more likely to mangle a payload this size than Gemini, so this
    # matters a lot more for provider="ollama" than for the cloud default.
    if config is None:
        correction_response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=16000,
            messages=[
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": text},
                {"role": "user", "content": (
                    "That was not valid JSON "
                    f"(error at char {error.pos}: {error.msg}). "
                    "Return ONLY the corrected, complete, valid JSON object — "
                    "no markdown fences, no explanation, no truncation."
                )},
            ],
        )
        text = _extract_text(correction_response)
        config, error = _try_parse(text)

    if config is None:
        raise ValueError(
            f"Bootstrap response was not valid JSON after one retry. "
            f"Error at char {error.pos}: {error.msg}. "
            f"Try a simpler purpose description, or a different model if running local-only."
        )

    # Second validation pass: valid JSON doesn't mean valid Python inside the
    # `implementation` strings. One correction retry, same shape as the JSON
    # retry above; if it's still broken, drop just the offending tool(s)
    # rather than failing the whole agent over one bad tool.
    tool_errors = _tool_syntax_errors(config)
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
                    f"valid Python and fail to compile: {_describe_tool_errors(tool_errors)}. "
                    "Return ONLY the corrected, complete, valid JSON object with fixed "
                    "implementations — no markdown fences, no explanation, no truncation."
                )},
            ],
        )
        text = _extract_text(correction_response)
        retried_config, retry_error = _try_parse(text)
        if retried_config is not None:
            config = retried_config
            tool_errors = _tool_syntax_errors(config)

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
    bootstrap_memory.record(purpose, config, provider, is_worker)
    return config


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
    purpose: str, provider: str | None = None, model: str | None = None, is_worker: bool = False
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

    Event shapes:
      {"type": "status", "message": "..."}
      {"type": "tool",   "name": "..."}
      {"type": "done",   "config": {...}}
      {"type": "error",  "message": "..."}
    """
    yield {"type": "status", "message": "Thinking about your purpose…"}

    prompt, fewshot_count = _build_prompt(purpose, provider, is_worker)
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
            messages=[{"role": "user", "content": prompt}],
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
        yield {"type": "status", "message": "Fixing malformed response…"}
        correction_meta: dict = {}
        try:
            correction_response = create_chat_completion(
                provider=provider,
                model=model,
                max_tokens=16000,
                _meta=correction_meta,
                messages=[
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": (
                        "That was not valid JSON "
                        f"(error at char {error.pos}: {error.msg}). "
                        "Return ONLY the corrected, complete, valid JSON object — "
                        "no markdown fences, no explanation, no truncation."
                    )},
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
        yield {"type": "error", "message": (
            f"Bootstrap response was not valid JSON after one retry. "
            f"Error at char {error.pos}: {error.msg}. "
            f"Try a simpler purpose description, or a different model if running local-only."
        )}
        return

    # Same compile-check + one correction retry as generate_agent_config —
    # see _tool_syntax_errors for why JSON validity alone isn't enough.
    tool_errors = _tool_syntax_errors(config)
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
                        f"valid Python and fail to compile: {_describe_tool_errors(tool_errors)}. "
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
                tool_errors = _tool_syntax_errors(config)
        except Exception as e:
            yield _model_event(tool_fix_meta)
            yield {"type": "error", "message": f"Tool-code correction retry failed: {e}"}
            return

    if tool_errors:
        broken = {name for name, _ in tool_errors}
        config["tools"] = [
            t for t in config.get("tools", [])
            if not isinstance(t, dict) or t.get("name") not in broken
        ]

    _resolve_mcp_tools(config)
    _normalize_persona(config)
    config["purpose"] = purpose
    config["provider"] = provider
    config["ollama_model"] = model
    bootstrap_memory.record(purpose, config, provider, is_worker)
    yield {"type": "done", "config": config}
