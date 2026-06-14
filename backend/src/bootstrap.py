import json
import anthropic

client = anthropic.Anthropic()

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
      "description": "<what this tool does — Claude reads this to decide when to call it>",
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

A primitive tool `fetch_page` is pre-built and always available to the agent — do NOT include it in the tools array you generate. It takes a `url` (string) and returns `{status_code, url, content, truncated}` where `content` is clean text with all HTML, scripts, and SVG stripped. Instruct the agent to call `fetch_page` directly to retrieve any web page.

Rules:
- Design tools that directly serve the stated purpose
- Tool implementations must be self-contained Python snippets
- Do NOT generate a fetch_url, fetch_page, scrape, or HTTP-request tool — use the built-in `fetch_page` primitive instead
- Do NOT generate a web_search, search_web, google_search, or any internet-search tool — there is no search engine available; agents must use `fetch_page` with direct URLs
- Always include a `save_output` tool that writes a final result using os.path.join(TEMP_DIR, filename); the tool must set result = {"status": "saved", "filename": filename, "path": os.path.join(TEMP_DIR, filename)}
- The system_prompt you generate MUST instruct the agent that after all tool calls are done it must present the actual findings (listings, data, analysis) in its reply — not list tool names, not say "search complete"
- Search/fetch tools MUST filter results for relevance: only include items where the search keyword appears in the title or description/snippet (case-insensitive). Discard unrelated results returned by the API.
- Return ONLY valid JSON — no markdown fences, no explanation
"""


def generate_agent_config(purpose: str) -> dict:
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=16000,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": _BOOTSTRAP_PROMPT.format(purpose=purpose)}],
    )

    text = next(
        (block.text for block in response.content if block.type == "text"),
        "{}",
    )

    try:
        config = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Bootstrap response was not valid JSON (likely truncated). "
            f"Error at char {e.pos}: {e.msg}. "
            f"Try a simpler purpose description to reduce output size."
        ) from e

    config["purpose"] = purpose
    return config
