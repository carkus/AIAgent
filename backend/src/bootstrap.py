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
- The following are pre-injected and ready to use WITHOUT importing: `requests`, `json`, `os`
- Do NOT write `import requests`, `import json`, or `import os` — they are already available
- You MAY import other standard-library modules (e.g. `import re`, `import urllib.parse`)
- File writes must go to /tmp/<filename> — use `open('/tmp/filename', 'w')`
- Always assign the final result to a variable named `result`

Rules:
- Design tools that directly serve the stated purpose
- Tool implementations must be self-contained Python snippets
- Always include a `save_output` tool that writes a final result to /tmp/<filename>
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
