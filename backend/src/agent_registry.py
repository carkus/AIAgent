"""
Server-side persistence for "published" agents — the slice of AgentConfig
persistence (see AIAgent/CLAUDE.md Limitation #7) needed to expose
bootstrapped agents as MCP tools (mcp_server.py).

Publishing is an explicit, human-in-the-loop step (a button in Chat.tsx
after the user has actually exercised the agent) rather than automatic —
every generated tool's implementation runs via exec() with only a builtins
allowlist, not a real sandbox (Limitation #2), so turning a one-off
bootstrap into a permanently externally-callable tool is a deliberate
choice, not a side effect of bootstrapping.

Same file-store pattern as saved_searches.py: JSON file under DATA_DIR,
threading.Lock + atomic replace (write to .tmp, os.replace). DATA_DIR
deliberately lives outside backend/ — see deploy/redeploy.sh's
deploy_backend(), which tars and overwrites the entire backend/ directory on
every deploy.

Single gunicorn worker in production (deploy/aiagent.service) for the Flask
app, and mcp_server.py runs as its own single-process uvicorn service
(deploy/aiagent-mcp.service) — both processes share this same file, so the
threading.Lock only guards against races within one process; cross-process
races are last-writer-wins on the same file, acceptable at this scale (rare,
human-triggered publish/unpublish calls, not high-frequency writes).
"""

import json
import os
import re
import threading
import time
import uuid

_lock = threading.Lock()


def _data_path() -> str:
    data_dir = os.environ.get("DATA_DIR", os.getcwd())
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "agent_registry.json")


def _load() -> list:
    path = _data_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save(agents: list) -> None:
    path = _data_path()
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(agents, f, indent=2)
    os.replace(tmp_path, path)


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", name.strip().lower()).strip("_")
    return slug or "agent"


def _unique_tool_name(name: str, existing: list) -> str:
    base = _slugify(name)
    taken = {a["tool_name"] for a in existing}
    if base not in taken:
        return base
    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def list_agents() -> list:
    """All published agents, most recently published first."""
    with _lock:
        return _load()


def get_by_tool_name(tool_name: str) -> dict | None:
    with _lock:
        for a in _load():
            if a.get("tool_name") == tool_name:
                return a
    return None


def publish(name: str, description: str, agent_config: dict) -> dict:
    """Publish an AgentConfig, making it callable as an MCP tool. tool_name
    is derived from name and deduplicated against existing published agents
    — it's the literal MCP tool name a client calls, so once assigned it
    stays fixed for this entry (re-publishing under the same name creates a
    new entry with a suffixed tool_name, it does not overwrite)."""
    with _lock:
        agents = _load()
        entry = {
            "id": uuid.uuid4().hex,
            "tool_name": _unique_tool_name(name, agents),
            "name": name,
            "description": description,
            "agent_config": agent_config,
            "created_at": time.time(),
        }
        agents.insert(0, entry)
        _save(agents)
    return entry


def unpublish(agent_id: str) -> None:
    with _lock:
        agents = _load()
        agents = [a for a in agents if a.get("id") != agent_id]
        _save(agents)
