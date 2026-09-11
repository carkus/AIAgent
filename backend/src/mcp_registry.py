"""
The "vetted MCP server directory" (CLAUDE.md MCP priority 6): "bootstrap
could instead pick from a directory of already-vetted MCP servers/tools
matching the stated purpose and wire up the choice of tool, never its
implementation."

Deliberately kept to one entry for this first pass — same "first scaffold"
philosophy as orchestrator.py's delegate_to_worker: prove the mechanism
(catalog -> bootstrap selection -> real MCP call at execution time) end to
end before growing the list. Adding a second vetted server later (e.g.
mcp-server-fetch, mcp-server-git) is a one-entry addition here, nothing else
needs to change.

Every server listed must be a real, independently-vetted MCP server, not
something invented for this project — the whole point is removing
hallucinated implementations, not just relocating them. mcp-server-time is
the official reference server maintained under
https://github.com/modelcontextprotocol/servers (Anthropic, MIT-licensed,
published on PyPI), pure Python so it needs no node/npx on the droplet —
just `pip install mcp-server-time` (see requirements.txt).
"""
import sys

MCP_SERVERS = {
    "time": {
        "command": sys.executable,
        "args": ["-m", "mcp_server_time"],
        "description": "Official MCP reference server for current time and timezone conversion.",
    },
}
