import json
import time
import anthropic
from tools import execute_tool, fetch_page

client = anthropic.Anthropic()

_PRIMITIVE_TOOLS = [
    {
        "name": "fetch_page",
        "description": (
            "Fetch any public web page and return its clean text content (HTML, scripts, "
            "and SVG stripped). Use this to read job listings, salary guides, company pages, "
            "or any web URL. Prefer this over generating your own fetch tool."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full URL to fetch"}
            },
            "required": ["url"],
        },
    }
]


def run_agent_stream(messages: list, agent_config: dict):
    """
    Generator that yields event dicts as the agent loop runs.

    Event shapes:
      {"type": "tool_start",  "tool": "name", "inputs": {...}}
      {"type": "tool_result", "tool": "name", "result": "..."}
      {"type": "done",        "response": "...", "tool_calls": [...], "duration_seconds": N}
      {"type": "error",       "message": "..."}
    """
    system_prompt = agent_config["system_prompt"] + """

---
CRITICAL TOOL RULES — READ BEFORE CALLING ANY TOOL:

1. DO NOT call `web_search` or any search tool. There is no search engine connected. Every call returns 0 results and wastes a turn.

2. USE `fetch_page` to get live data directly from job boards and websites:
   - SEEK (Australia's largest job board) URL pattern:
     https://www.seek.com.au/{keyword}-jobs/in-{location}
     e.g. https://www.seek.com.au/flutter-developer-jobs/in-Melbourne-VIC
          https://www.seek.com.au/software-engineer-jobs/in-Melbourne-VIC
   - Replace spaces with hyphens in the keyword.
   - The page text will contain job counts, titles, companies, salaries, and listing descriptions.

3. MANDATORY OUTPUT: When all fetches are done, write the actual findings — listing counts, job titles, salary ranges, company names. Do not say "search complete" or list tool names. The user cannot see tool output; your reply IS the report.
---"""
    tool_definitions = agent_config["tools"]

    tools = _PRIMITIVE_TOOLS + [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["input_schema"],
        }
        for t in tool_definitions
    ]

    impl_map = {t["name"]: t["implementation"] for t in tool_definitions}
    current_messages = list(messages)
    tool_calls_log = []
    started_at = time.time()
    total_input_tokens = 0
    total_output_tokens = 0
    rate_limits = {}
    nudged = False

    try:
        while True:
            raw = client.messages.with_raw_response.create(
                model="claude-opus-4-8",
                max_tokens=16000,
                thinking={"type": "adaptive"},
                system=system_prompt,
                tools=tools,
                messages=current_messages,
            )
            response = raw.parse()

            total_input_tokens += response.usage.input_tokens
            total_output_tokens += response.usage.output_tokens

            # Capture most-recent rate limit headers (reset every minute)
            h = raw.headers
            rate_limits = {
                "tokens_limit":      h.get("anthropic-ratelimit-tokens-limit"),
                "tokens_remaining":  h.get("anthropic-ratelimit-tokens-remaining"),
                "tokens_reset":      h.get("anthropic-ratelimit-tokens-reset"),
                "requests_limit":    h.get("anthropic-ratelimit-requests-limit"),
                "requests_remaining": h.get("anthropic-ratelimit-requests-remaining"),
            }

            current_messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason in ("end_turn", "max_tokens"):
                final_text = next(
                    (block.text for block in response.content if block.type == "text"),
                    "",
                )
                # Auto-nudge: if Claude gave a very short response after running tools,
                # inject one follow-up so it actually presents the findings.
                if (
                    not nudged
                    and tool_calls_log
                    and response.stop_reason == "end_turn"
                    and len(final_text.strip()) < 400
                ):
                    nudged = True
                    current_messages.append({
                        "role": "user",
                        "content": (
                            "Present your complete findings now in full detail. "
                            "Show the actual data, results, and analysis from your searches."
                        ),
                    })
                    continue
                yield {
                    "type": "done",
                    "response": final_text,
                    "tool_calls": tool_calls_log,
                    "duration_seconds": round(time.time() - started_at, 1),
                    "usage": {
                        "input_tokens": total_input_tokens,
                        "output_tokens": total_output_tokens,
                    },
                    "rate_limits": rate_limits,
                }
                return

            if response.stop_reason != "tool_use":
                yield {"type": "error", "message": f"Unexpected stop reason: {response.stop_reason}"}
                return

            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue

                yield {"type": "tool_start", "tool": block.name, "inputs": block.input}

                _SEARCH_TOOL_NAMES = {
                    "web_search", "search_web", "google_search", "bing_search",
                    "search", "search_jobs", "search_internet", "internet_search",
                }
                if block.name == "fetch_page":
                    result = fetch_page(block.input.get("url", ""))
                elif block.name in _SEARCH_TOOL_NAMES:
                    result = {
                        "error": (
                            "No search engine is connected. Do NOT call this tool again. "
                            "Use fetch_page with a direct URL instead — "
                            "e.g. fetch_page('https://www.seek.com.au/software-engineer-jobs/in-Melbourne-VIC')"
                        )
                    }
                else:
                    implementation = impl_map.get(block.name, "result = 'Unknown tool'")
                    result = execute_tool(implementation, block.input)
                try:
                    result_str = json.dumps(result, default=str)
                except Exception:
                    result_str = str(result)

                tool_calls_log.append({
                    "tool": block.name,
                    "inputs": block.input,
                    "result": result_str,
                })

                yield {"type": "tool_result", "tool": block.name, "result": result_str}

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result_str,
                })

            current_messages.append({"role": "user", "content": tool_results})

    except Exception as e:
        yield {"type": "error", "message": str(e)}
