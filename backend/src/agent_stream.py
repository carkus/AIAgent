import json
import time
from llm_client import create_chat_completion
from tools import execute_tool, fetch_page, search_jobs

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
    }
]

_SEARCH_TOOL_NAMES = {
    "web_search", "search_web", "google_search", "bing_search",
    "search", "search_internet", "internet_search",
}


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

1. DO NOT call `web_search` or any generic search tool. There is no search engine connected. Every call returns 0 results and wastes a turn.

2. For job search, salary research, or job-market questions, USE `search_jobs` — it calls a real
   job search API and returns structured listings (title, company, location, salary, apply URL).
   Do NOT use `fetch_page` against SEEK/Indeed/LinkedIn or similar job boards — they block this
   server's IP with a 403 regardless of headers, so it will not work.

3. USE `fetch_page` for everything else — company pages, news, general URLs.

4. MANDATORY OUTPUT: When all fetches are done, write the actual findings — listing counts, job titles, salary ranges, company names. Do not say "search complete" or list tool names. The user cannot see tool output; your reply IS the report.
---"""

    tool_definitions = agent_config["tools"]

    tools = _PRIMITIVE_TOOLS + [
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

    impl_map = {t["name"]: t["implementation"] for t in tool_definitions}
    provider = agent_config.get("provider")
    model = agent_config.get("ollama_model")

    # Build initial message list: system prompt first, then conversation history
    current_messages: list[dict] = [{"role": "system", "content": system_prompt}]
    for m in messages:
        current_messages.append({"role": m["role"], "content": m["content"]})

    tool_calls_log = []
    started_at = time.time()
    total_input_tokens = 0
    total_output_tokens = 0
    nudged = False
    # Hard ceiling on LLM calls per request — without this, a model stuck in a
    # tool-calling loop (or a buggy tool) burns unlimited API quota on one request.
    max_iterations = 25

    try:
        for _ in range(max_iterations):
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
            assistant_msg["content"] = assistant_msg.get("content") or ""
            current_messages.append(assistant_msg)

            # No tool calls → final response
            if not message.tool_calls:
                final_text = message.content or ""
                if (
                    not nudged
                    and tool_calls_log
                    and finish_reason == "stop"
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
                    "rate_limits": {
                        "tokens_limit": None,
                        "tokens_remaining": None,
                        "tokens_reset": None,
                        "requests_limit": None,
                        "requests_remaining": None,
                    },
                }
                return

            # Execute each tool call and collect results
            tool_result_messages = []
            for tc in message.tool_calls:
                tool_name = tc.function.name
                try:
                    tool_inputs = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    tool_inputs = {}

                yield {"type": "tool_start", "tool": tool_name, "inputs": tool_inputs}

                if tool_name == "fetch_page":
                    result = fetch_page(tool_inputs.get("url", ""))
                elif tool_name == "search_jobs":
                    result = search_jobs(
                        what=tool_inputs.get("what", ""),
                        where=tool_inputs.get("where", ""),
                        country=tool_inputs.get("country") or "au",
                        results_per_page=tool_inputs.get("results_per_page") or 20,
                        page=tool_inputs.get("page") or 1,
                    )
                elif tool_name in _SEARCH_TOOL_NAMES:
                    result = {
                        "error": (
                            "No generic search engine is connected. Do NOT call this tool again. "
                            "For job listings/salary data, call search_jobs instead. "
                            "For any other URL, use fetch_page."
                        )
                    }
                else:
                    implementation = impl_map.get(tool_name, "result = 'Unknown tool'")
                    result = execute_tool(implementation, tool_inputs)

                try:
                    result_str = json.dumps(result, default=str)
                except Exception:
                    result_str = str(result)

                tool_calls_log.append({
                    "tool": tool_name,
                    "inputs": tool_inputs,
                    "result": result_str,
                })

                yield {"type": "tool_result", "tool": tool_name, "result": result_str}

                tool_result_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_str,
                })

            current_messages.extend(tool_result_messages)

        yield {"type": "error", "message": f"Stopped after {max_iterations} tool-call rounds without a final answer."}

    except Exception as e:
        yield {"type": "error", "message": str(e)}
