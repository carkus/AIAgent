"""
The "vetted MCP server directory" (CLAUDE.md MCP priority 6): "bootstrap
could instead pick from a directory of already-vetted MCP servers/tools
matching the stated purpose and wire up the choice of tool, never its
implementation."

Started as one entry (mcp-server-time) to prove the mechanism end to end —
same "first scaffold" philosophy as orchestrator.py's delegate_to_worker —
before growing the list. Confirmed a second entry really is a one-dict-entry
addition here with nothing else to change, per this file's own original
note.

Every server listed must be a real, independently-vetted MCP server, not
something invented for this project — the whole point is removing
hallucinated implementations, not just relocating them. Both entries below
are official reference servers maintained under
https://github.com/modelcontextprotocol/servers (Anthropic, MIT-licensed,
published on PyPI), pure Python so neither needs node/npx on the droplet —
just `pip install` (see requirements.txt).
"""
import sys

MCP_SERVERS = {
    "time": {
        "command": sys.executable,
        "args": ["-m", "mcp_server_time"],
        "description": "Official MCP reference server for current time and timezone conversion.",
    },
    "fetch": {
        "command": sys.executable,
        "args": ["-m", "mcp_server_fetch"],
        "description": "Official MCP reference server for fetching a URL and returning its content as clean markdown.",
    },
}
