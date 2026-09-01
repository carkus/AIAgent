import time
from llm_client import create_chat_completion
from tools import execute_tool


def run_agent(messages: list, agent_config: dict) -> dict:
    system_prompt = agent_config["system_prompt"]
    tool_definitions = agent_config["tools"]

    # Tool schemas in OpenAI-compatible function-calling format
    tools = [
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

    # Implementation lookup by tool name
    impl_map = {t["name"]: t["implementation"] for t in tool_definitions}

    current_messages = [{"role": "system", "content": system_prompt}, *messages]
    provider = agent_config.get("provider")
    model = agent_config.get("ollama_model")
    tool_calls_log = []
    started_at = time.time()

    while True:
        response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=4096,
            tools=tools,
            messages=current_messages,
        )

        assistant_content = []
        for choice in response.choices:
            if choice.message.content:
                assistant_content.append({"type": "text", "text": choice.message.content})
            if choice.message.tool_calls:
                for tool_call in choice.message.tool_calls:
                    assistant_content.append({
                        "type": "tool_use",
                        "id": tool_call.id,
                        "name": tool_call.function.name,
                        "input": tool_call.function.arguments if isinstance(tool_call.function.arguments, dict) else {}
                    })

        current_messages.append({"role": "assistant", "content": assistant_content})

        # Check if there are any tool calls
        has_tool_calls = any(item.get("type") == "tool_use" for item in assistant_content)

        if not has_tool_calls:
            final_text = next(
                (item["text"] for item in assistant_content if item.get("type") == "text"),
                "",
            )
            return {
                "response": final_text,
                "tool_calls": tool_calls_log,
                "duration_seconds": round(time.time() - started_at, 1),
            }

        tool_results = []
        for item in assistant_content:
            if item.get("type") != "tool_use":
                continue

            implementation = impl_map.get(item["name"], "result = 'Unknown tool'")
            result = execute_tool(implementation, item.get("input", {}))

            tool_calls_log.append({
                "tool": item["name"],
                "inputs": item.get("input", {}),
                "result": str(result)[:1000],
            })

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": item["id"],
                "content": str(result),
            })

        current_messages.append({"role": "user", "content": tool_results})

    return {
        "response": "Agent loop ended unexpectedly.",
        "tool_calls": tool_calls_log,
        "duration_seconds": round(time.time() - started_at, 1),
    }
