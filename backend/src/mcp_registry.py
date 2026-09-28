"""
The "vetted MCP server directory" (CLAUDE.md MCP priority 6): "bootstrap
could instead pick from a directory of already-vetted MCP servers/tools
matching the stated purpose and wire up the choice of tool, never its
implementation."

Started as one entry (mcp-server-time) to prove the mechanism end to end —
same "first scaffold" philosophy as orchestrator.py's delegate_to_worker —
before growing the list.

Every server listed must be a real, independently-vetted MCP server, not
something invented for this project — the whole point is removing
hallucinated implementations, not just relocating them.

Two transport kinds now, both handled by mcp_client.py's `_session_cm`:

- "stdio" (time, fetch) — official reference servers maintained under
  https://github.com/modelcontextprotocol/servers (Anthropic, MIT-licensed,
  published on PyPI), pure Python so neither needs node/npx on the droplet —
  just `pip install` (see requirements.txt). mcp_client.py spawns these as a
  subprocess per call.
- "http" (search) — Tavily's own official *remote* MCP server
  (https://docs.tavily.com/documentation/mcp), reached over Streamable HTTP.
  No subprocess, no extra pip package, no node — the `mcp` SDK already
  installed for the stdio servers above talks HTTP just as natively. This
  was chosen over the two Node-based general-search options (the official
  Brave Search MCP server, and Tavily's own local npx server) specifically
  to avoid adding a Node/npx runtime to a droplet that has only ever run
  Python. The community-maintained pip wrapper that used to exist for
  Tavily (`mcp-tavily`) is archived/deprecated in favor of this official
  remote server, so it was never installed here.
"""
import os
import sys

MCP_SERVERS = {
    "time": {
        "transport": "stdio",
        "command": sys.executable,
        "args": ["-m", "mcp_server_time"],
        "description": "Official MCP reference server for current time and timezone conversion.",
    },
    "fetch": {
        "transport": "stdio",
        "command": sys.executable,
        "args": ["-m", "mcp_server_fetch"],
        "description": "Official MCP reference server for fetching a URL and returning its content as clean markdown.",
    },
}

# Omitted entirely (rather than listed as permanently "unreachable") when no
# key is configured — same "skip silently, don't advertise a broken
# integration" convention as llm_client.py skipping Gemini without
# GEMINI_API_KEY. Set TAVILY_API_KEY in env.json (local) or the droplet's
# .env (prod) to enable general web search for bootstrapped agents.
_tavily_key = os.environ.get("TAVILY_API_KEY")
if _tavily_key:
    MCP_SERVERS["search"] = {
        "transport": "http",
        "url": f"https://mcp.tavily.com/mcp/?tavilyApiKey={_tavily_key}",
        "description": (
            "Tavily's official remote MCP server for general web search — "
            "finding pages/topics by query, not just fetching a URL you "
            "already have."
        ),
    }
