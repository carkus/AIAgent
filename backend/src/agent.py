import time
import anthropic
from tools import execute_tool

client = anthropic.Anthropic()


def run_agent(messages: list, agent_config: dict) -> dict:
    system_prompt = agent_config["system_prompt"]
    tool_definitions = agent_config["tools"]

    # Tool schemas passed to Claude
    tools = [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["input_schema"],
        }
        for t in tool_definitions
    ]

    # Implementation lookup by tool name
    impl_map = {t["name"]: t["implementation"] for t in tool_definitions}

    current_messages = list(messages)
    tool_calls_log = []
    started_at = time.time()

    while True:
        response = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=4096,
            thinking={"type": "adaptive"},
            system=system_prompt,
            tools=tools,
            messages=current_messages,
        )

        current_messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            final_text = next(
                (block.text for block in response.content if block.type == "text"),
                "",
            )
            return {
                "response": final_text,
                "tool_calls": tool_calls_log,
                "duration_seconds": round(time.time() - started_at, 1),
            }

        if response.stop_reason != "tool_use":
            break

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            implementation = impl_map.get(block.name, "result = 'Unknown tool'")
            result = execute_tool(implementation, block.input)

            tool_calls_log.append({
                "tool": block.name,
                "inputs": block.input,
                "result": str(result)[:1000],
            })

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": str(result),
            })

        current_messages.append({"role": "user", "content": tool_results})

    return {
        "response": "Agent loop ended unexpectedly.",
        "tool_calls": tool_calls_log,
        "duration_seconds": round(time.time() - started_at, 1),
    }
