import json
from llm_client import create_chat_completion

_BOOTSTRAP_PROMPT = """\
You are a meta-agent configurator. A user wants a custom AI agent for the following purpose:

<purpose>
{purpose}
</purpose>

Design and configure this agent. Return a single JSON object with exactly these fields:

{{
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

A primitive tool `fetch_page` is pre-built and always available to the agent — do NOT include it in the tools array you generate. It takes a `url` (string) and returns `{{status_code, url, content, char_count, truncated, listing_count}}` where `content` is clean text with all HTML, scripts, and SVG stripped, and `listing_count` is the number of job listings found on the page (if any). Instruct the agent to call `fetch_page` directly to retrieve any web page.

Rules:
- Design tools that directly serve the stated purpose
- Tool implementations must be self-contained Python snippets
- Do NOT generate a fetch_url, fetch_page, scrape, or HTTP-request tool — use the built-in `fetch_page` primitive instead
- Do NOT generate a web_search, search_web, google_search, or any internet-search tool — there is no search engine available; agents must use `fetch_page` with direct URLs
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


def generate_agent_config(purpose: str, provider: str | None = None, model: str | None = None) -> dict:
    response = create_chat_completion(
        provider=provider,
        model=model,
        max_tokens=16000,
        messages=[{"role": "user", "content": _BOOTSTRAP_PROMPT.format(purpose=purpose)}],
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
                {"role": "user", "content": _BOOTSTRAP_PROMPT.format(purpose=purpose)},
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

    config["purpose"] = purpose
    # Carried in AgentConfig so every subsequent /agent turn in this session
    # reuses the same provider/model choice made on the Setup screen.
    config["provider"] = provider
    config["ollama_model"] = model
    return config
