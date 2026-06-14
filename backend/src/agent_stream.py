import time
import anthropic
from tools import execute_tool

client = anthropic.Anthropic()


def run_agent_stream(messages: list, agent_config: dict):
    """
    Generator that yields event dicts as the agent loop runs.

    Event shapes:
      {"type": "tool_start",  "tool": "name", "inputs": {...}}
      {"type": "tool_result", "tool": "name", "result": "..."}
      {"type": "done",        "response": "...", "tool_calls": [...], "duration_seconds": N}
      {"type": "error",       "message": "..."}
    """
    system_prompt = agent_config["system_prompt"]
    tool_definitions = agent_config["tools"]

    tools = [
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

    try:
        while True:
            raw = client.messages.with_raw_response.create(
                model="claude-opus-4-8",
                max_tokens=4096,
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

            if response.stop_reason == "end_turn":
                final_text = next(
                    (block.text for block in response.content if block.type == "text"),
                    "",
                )
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

                implementation = impl_map.get(block.name, "result = 'Unknown tool'")
                result = execute_tool(implementation, block.input)
                result_str = str(result)[:1000]

                tool_calls_log.append({
                    "tool": block.name,
                    "inputs": block.input,
                    "result": result_str,
                })

                yield {"type": "tool_result", "tool": block.name, "result": result_str}

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": str(result),
                })

            current_messages.append({"role": "user", "content": tool_results})

    except Exception as e:
        yield {"type": "error", "message": str(e)}
