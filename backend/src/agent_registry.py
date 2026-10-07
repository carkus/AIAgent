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

Stored in the shared SQLite database (db.py, table agent_registry) under
DATA_DIR, which deliberately lives outside backend/ — see
deploy/redeploy.sh's deploy_backend(), which tars and overwrites the entire
backend/ directory on every deploy. gunicorn (publish/unpublish) and
mcp_server.py (list/get) both use it; SQLite's transactions make that safe
across processes, and the UNIQUE tool_name column means two concurrent
publishes can't both claim the same MCP tool name.
"""

import re
import time
import uuid

import db


def _insert(conn, entry: dict) -> None:
    conn.execute(
        "INSERT INTO agent_registry (id, tool_name, agent_config_id, data) VALUES (?, ?, ?, ?)",
        (
            entry["id"],
            entry["tool_name"],
            (entry.get("agent_config") or {}).get("agent_config_id"),
            db.dumps(entry),
        ),
    )


def _migrate() -> None:
    # agent_registry.json was stored newest first; insert oldest first so
    # ORDER BY seq DESC reproduces the same order.
    def insert_rows(conn, items):
        seen = set()
        for item in reversed(items):
            if not item.get("tool_name") or item["tool_name"] in seen:
                continue
            seen.add(item["tool_name"])
            item.setdefault("id", uuid.uuid4().hex)
            _insert(conn, item)
    db.migrate_json_store("agent_registry", "agent_registry.json", insert_rows)


def _load(conn) -> list:
    rows = conn.execute("SELECT data FROM agent_registry ORDER BY seq DESC").fetchall()
    return [db.loads(r["data"]) for r in rows]


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
    _migrate()
    with db.read() as conn:
        return _load(conn)


def get_by_tool_name(tool_name: str) -> dict | None:
    _migrate()
    with db.read() as conn:
        row = conn.execute(
            "SELECT data FROM agent_registry WHERE tool_name = ?", (tool_name,)
        ).fetchone()
    return db.loads(row["data"]) if row else None


def publish(name: str, description: str, agent_config: dict) -> dict:
    """Publish an AgentConfig, making it callable as an MCP tool.

    bootstrap.py stamps every generated AgentConfig with a stable
    `agent_config_id`, independent of its (editable) name/description. If
    this agent_config_id already has a published entry, that entry is
    updated in place (same `id`/`tool_name`, refreshed name/description/
    agent_config/created_at) rather than inserting a duplicate — without
    this, clicking "Publish as MCP tool" again for the same bootstrapped
    agent (e.g. after continuing the chat) silently produced a second
    registry row for what was conceptually the same agent, just under a
    suffixed tool_name like `_2`. An older AgentConfig with no
    agent_config_id (bootstrapped before this field existed) has nothing to
    match against, so it falls through to the original create-new-entry
    behavior unchanged.

    tool_name is derived from name and deduplicated against existing
    published agents for a genuinely new entry — it's the literal MCP tool
    name a client calls, so once assigned it stays fixed for that entry."""
    _migrate()
    with db.write() as conn:
        config_id = agent_config.get("agent_config_id")
        row = conn.execute(
            "SELECT data FROM agent_registry WHERE agent_config_id = ? ORDER BY seq DESC LIMIT 1",
            (config_id,),
        ).fetchone() if config_id else None
        if row is not None:
            existing = db.loads(row["data"])
            existing["name"] = name
            existing["description"] = description
            existing["agent_config"] = agent_config
            existing["created_at"] = time.time()
            # Updated in place: keeps its seq, so its list position doesn't
            # move — same as the JSON store mutating the entry where it sat.
            conn.execute(
                "UPDATE agent_registry SET data = ? WHERE id = ?",
                (db.dumps(existing), existing["id"]),
            )
            return existing

        entry = {
            "id": uuid.uuid4().hex,
            "tool_name": _unique_tool_name(name, _load(conn)),
            "name": name,
            "description": description,
            "agent_config": agent_config,
            "created_at": time.time(),
        }
        _insert(conn, entry)
    return entry


def unpublish(agent_id: str) -> None:
    _migrate()
    with db.write() as conn:
        conn.execute("DELETE FROM agent_registry WHERE id = ?", (agent_id,))
