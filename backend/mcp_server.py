"""
MCP server exposing published agents (src/agent_registry.py) as MCP tools —
root c:\\_work\\CLAUDE.md's Gaps item 4: "AIAgent's generated agents as MCP
servers", mirroring jobfit's own `/mcp` endpoint (Mcp/JobFitMcpTools.cs).

Lives next to server.py (not in src/) because, like server.py, it's a
runnable entrypoint of its own — not a library module imported by something
else — and the two mirror each other's deployment shape: same
WorkingDirectory, same "ExecStart runs `<module>:app`" pattern
(deploy/aiagent.service's `server:app` under gunicorn vs.
deploy/aiagent-mcp.service's `mcp_server:app` under uvicorn).

Runs as its own ASGI process, separate from server.py's Flask/gunicorn WSGI
app. This isn't a style choice: the official `mcp` SDK's HTTP transports
(mcp.server.sse, mcp.server.streamable_http_manager) are Starlette/ASGI-only
(confirmed by their own imports — `from starlette.requests import Request`
etc.) and the SDK ships no WSGI transport, so this can't be added as routes
on the existing Flask app.

Uses the low-level `mcp.server.lowlevel.Server` API, not `mcp.server.fastmcp`
— FastMCP's `@mcp.tool()` decorator registers a fixed tool list at import
time; here the tool list is agent_registry.list_agents(), which changes as
agents are published/unpublished, so list_tools()/call_tool() need to be
handlers re-invoked fresh on every request (confirmed by reading
mcp/server/lowlevel/server.py — that's exactly what those decorators do).

Each published agent becomes one MCP tool taking a single `message` string
input. Calling it drives the *existing* agent-execution pipeline
(run_agent_stream) to completion and returns its final text response — same
"thin wrapper over the existing execution path" principle as
orchestrator.run_worker() for delegated workers, and as jobfit's own MCP
tools over its appraisal pipeline. No new agent logic here.

Usage:
    Dev:  python backend/mcp_server.py         (defaults to port 4892)
    Prod: uvicorn mcp_server:app under deploy/aiagent-mcp.service,
          reverse-proxied at /mcp by deploy/nginx-aiagent.conf.
"""

import asyncio
import json
import os
import sys

# Same env.json / DATA_DIR bootstrap as server.py, duplicated here rather than
# imported from it since this runs as its own process/entrypoint.
_ROOT = os.path.dirname(os.path.abspath(__file__))
_ENV_JSON = os.path.join(os.path.dirname(_ROOT), "env.json")
if os.path.exists(_ENV_JSON):
    with open(_ENV_JSON) as f:
        _sections = json.load(f)
    for _section in _sections.values():
        for k, v in _section.items():
            os.environ.setdefault(k, v)

os.environ.setdefault("DATA_DIR", os.path.join(os.path.dirname(_ROOT), "data"))

sys.path.insert(0, os.path.join(_ROOT, "src"))

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.routing import Route

import agent_registry
from agent_stream import run_agent_stream

server = Server("aiagent")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    """Re-reads the registry on every call — the whole point of the
    low-level Server API here — so publish/unpublish takes effect
    immediately, with no MCP server restart."""
    return [
        types.Tool(
            name=a["tool_name"],
            description=a.get("description") or a.get("name", a["tool_name"]),
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "What to ask or tell this agent.",
                    }
                },
                "required": ["message"],
            },
        )
        for a in agent_registry.list_agents()
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    entry = agent_registry.get_by_tool_name(name)
    if entry is None:
        raise ValueError(f"Unknown tool: {name}")
    message = (arguments or {}).get("message", "")
    text = await asyncio.to_thread(_run_once, entry["agent_config"], message)
    return [types.TextContent(type="text", text=text)]


def _run_once(agent_config: dict, message: str) -> str:
    """Runs one stateless turn of the published agent's own loop to
    completion (run_agent_stream is a generator; this drains it) and
    returns its final response text. Mirrors "the backend is stateless" —
    one call in, one call out, no server-side conversation carried between
    MCP tool calls."""
    messages = [{"role": "user", "content": message}]
    final_text = ""
    for event in run_agent_stream(messages, agent_config, allow_delegation=True):
        if event.get("type") == "done":
            final_text = event.get("response", "")
        elif event.get("type") == "error":
            raise ValueError(event.get("message", "Agent run failed"))
    return final_text or "(agent produced no text response)"


session_manager = StreamableHTTPSessionManager(app=server, stateless=True)


class _StreamableHttpASGIApp:
    """Adapts the session manager to a plain ASGI app — same shape as the
    SDK's own internal StreamableHTTPASGIApp (mcp/server/fastmcp/server.py),
    duplicated here rather than imported since it's a private class."""

    async def __call__(self, scope, receive, send) -> None:
        await session_manager.handle_request(scope, receive, send)


app = Starlette(
    routes=[Route("/mcp", endpoint=_StreamableHttpASGIApp())],
    lifespan=lambda _app: session_manager.run(),
)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MCP_PORT", 4892))
    print(f"Starting MCP server on http://localhost:{port}/mcp")
    uvicorn.run(app, host="127.0.0.1", port=port)
