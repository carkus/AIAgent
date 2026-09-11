"""
Sync wrapper around the official `mcp` Python SDK's stdio client, so the rest
of this codebase (Flask, bootstrap.py, agent_stream.py — all synchronous) can
talk to a vetted MCP server (mcp_registry.py) without becoming async itself.

Each call spawns the server as a subprocess over stdio, does the MCP
handshake, and tears it down — simple and correct rather than maximally
fast, matching the "first scaffold, deliberately kept small" scope this
mirrors from orchestrator.py. Tool calls are already LLM/network-latency
bound, so a server's ~1s stdio startup is not the bottleneck. list_tools()
results ARE cached per server for the life of the process, since a reference
server's tool catalog doesn't change at runtime — this avoids re-spawning a
server on every single bootstrap call just to re-read the same schema.

Every public function degrades to "this server/tool isn't available" rather
than raising: an uninstalled or crashing vetted server should shrink the
catalog bootstrap sees, not break bootstrap or the agent loop.
"""
import asyncio
import logging

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from mcp_registry import MCP_SERVERS

logger = logging.getLogger(__name__)

_catalog_cache: dict[str, list[dict]] = {}


def _server_params(server_id: str) -> StdioServerParameters:
    spec = MCP_SERVERS[server_id]
    return StdioServerParameters(command=spec["command"], args=spec["args"])


def _run(coro):
    """Run an async MCP call from sync code. A fresh event loop per call is
    simplest and safe here — these are one-shot request/response calls, never
    long-lived, so there's no state to keep alive across calls."""
    return asyncio.run(coro)


async def _list_tools_async(server_id: str) -> list[dict]:
    async with stdio_client(_server_params(server_id)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return [
                {
                    "server_id": server_id,
                    "tool_name": t.name,
                    "description": t.description or "",
                    "input_schema": t.inputSchema or {"type": "object", "properties": {}},
                }
                for t in result.tools
            ]


async def _call_tool_async(server_id: str, tool_name: str, inputs: dict):
    async with stdio_client(_server_params(server_id)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, inputs)
            return _unpack_result(result)


def _unpack_result(result) -> object:
    """MCP tool results come back as a list of content blocks (usually
    TextContent). Flatten to a single string when it's all text — the common
    case — falling back to a list of best-effort dicts for anything else, so
    json.dumps(default=str) in agent_stream.py always has something sane."""
    blocks = getattr(result, "content", None) or []
    texts = [b.text for b in blocks if getattr(b, "type", None) == "text" and hasattr(b, "text")]
    if texts and len(texts) == len(blocks):
        text = "\n".join(texts)
        if getattr(result, "isError", False):
            return {"error": text}
        return text
    parts = []
    for b in blocks:
        if hasattr(b, "model_dump"):
            parts.append(b.model_dump())
        else:
            parts.append(str(b))
    if getattr(result, "isError", False):
        return {"error": parts}
    return parts


def list_tools(server_id: str) -> list[dict]:
    """Real tool schemas from a running vetted server — cached after first
    success. Returns [] if the server isn't installed/reachable, logged but
    not raised."""
    if server_id in _catalog_cache:
        return _catalog_cache[server_id]
    if server_id not in MCP_SERVERS:
        return []
    try:
        tools = _run(_list_tools_async(server_id))
        _catalog_cache[server_id] = tools
        return tools
    except Exception as e:
        logger.warning("MCP server '%s' unavailable, omitting from catalog: %s", server_id, e)
        return []


def catalog_summary() -> list[dict]:
    """[{server_id, tool_name, description, input_schema}, ...] across every
    registered server that's actually reachable right now. Used by
    bootstrap.py to ground the prompt in real tools, and to validate/resolve
    a model's "source": "mcp" tool picks."""
    catalog = []
    for server_id in MCP_SERVERS:
        catalog.extend(list_tools(server_id))
    return catalog


def call_tool(server_id: str, tool_name: str, inputs: dict) -> dict:
    try:
        return _run(_call_tool_async(server_id, tool_name, inputs))
    except Exception as e:
        return {"error": f"MCP call to {server_id}.{tool_name} failed: {e}"}
