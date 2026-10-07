"""
Server-side persistence for Setup screen "saved searches".

Previously these lived in the browser's localStorage, which is scoped per
origin (protocol+host+port) — every dev-server port change silently handed
the user a brand-new, empty storage bucket. This module replaces that with a
small server-side store so saved searches survive port/browser changes.

Stored in the shared SQLite database (db.py, table saved_searches) under the
DATA_DIR env var (set by server.py from its existing _ROOT computation),
which deliberately lives outside backend/ — see deploy/redeploy.sh's
deploy_backend(), which tars and overwrites the entire backend/ directory on
every deploy.
"""

import uuid

import db


def _insert(conn, entry: dict) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO saved_searches (id, data) VALUES (?, ?)",
        (entry["id"], db.dumps(entry)),
    )


def _migrate() -> None:
    # saved_searches.json was stored newest first; insert oldest first so
    # ORDER BY seq DESC reproduces the same order.
    def insert_rows(conn, items):
        for item in reversed(items):
            item.setdefault("id", uuid.uuid4().hex)
            _insert(conn, item)
    db.migrate_json_store("saved_searches", "saved_searches.json", insert_rows)


def _load(conn) -> list:
    rows = conn.execute("SELECT data FROM saved_searches ORDER BY seq DESC").fetchall()
    return [db.loads(r["data"]) for r in rows]


def list_searches() -> list:
    _migrate()
    with db.read() as conn:
        return _load(conn)


def add_search(name: str, keywords: list, agent_type: str | None) -> dict:
    entry = {
        "id": uuid.uuid4().hex,
        "name": name,
        "keywords": keywords,
        "agentType": agent_type,
    }
    _migrate()
    with db.write() as conn:
        # Same keywords saved under the same agent type is a distinct-entry
        # repeat — collapse it, matching the old localStorage behaviour.
        for s in _load(conn):
            if s.get("name") == name and s.get("agentType") == agent_type:
                conn.execute("DELETE FROM saved_searches WHERE id = ?", (s["id"],))
        _insert(conn, entry)
    return entry


def delete_search(search_id: str) -> None:
    _migrate()
    with db.write() as conn:
        conn.execute("DELETE FROM saved_searches WHERE id = ?", (search_id,))
