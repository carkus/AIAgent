import json
import time
from llm_client import create_chat_completion
from tools import execute_tool, fetch_page

_PRIMITIVE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": (
                "Fetch any public web page and return its clean text content (HTML, scripts, "
                "and SVG stripped). Use this to read job listings, salary guides, company pages, "
                "or any web URL. Prefer this over generating your own fetch tool."
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
    "search", "search_jobs", "search_internet", "internet_search",
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

            # Append assistant turn to history
            assistant_msg: dict = {"role": "assistant", "content": message.content or ""}
            if message.tool_calls:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in message.tool_calls
                ]
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
                elif tool_name in _SEARCH_TOOL_NAMES:
                    result = {
                        "error": (
                            "No search engine is connected. Do NOT call this tool again. "
                            "Use fetch_page with a direct URL instead — "
                            "e.g. fetch_page('https://www.seek.com.au/software-engineer-jobs/in-Melbourne-VIC')"
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
