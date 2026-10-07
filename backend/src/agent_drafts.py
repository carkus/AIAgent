"""
Server-side persistence for Setup screen "saved agent profiles" — the
pre-bootstrap draft (agent name, type, location, specialties) captured by the
"Save Agent" button, distinct from "Select Specialties" (keywords only, see
saved_searches.py) and from a "Saved Agent" chat (a fully bootstrapped agent
with real conversation history, see chatStorage.ts). No system prompt/tools
exist yet at this stage — that only happens once the draft is commissioned.

Stored in the shared SQLite database (db.py, table agent_drafts), same
pattern as saved_searches.py.
"""

import time
import uuid

import db


def _insert(conn, entry: dict) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO agent_drafts (id, data) VALUES (?, ?)",
        (entry["id"], db.dumps(entry)),
    )


def _migrate() -> None:
    # agent_drafts.json was stored newest first; insert oldest first so
    # ORDER BY seq DESC reproduces the same order.
    def insert_rows(conn, items):
        for item in reversed(items):
            item.setdefault("id", uuid.uuid4().hex)
            _insert(conn, item)
    db.migrate_json_store("agent_drafts", "agent_drafts.json", insert_rows)


def _load(conn) -> list:
    rows = conn.execute("SELECT data FROM agent_drafts ORDER BY seq DESC").fetchall()
    return [db.loads(r["data"]) for r in rows]


def list_drafts() -> list:
    _migrate()
    with db.read() as conn:
        return _load(conn)


def add_draft(
    agent_name: str,
    agent_type: str | None,
    keywords: list,
    location: str,
    traits: list,
    behavior_toggles: list | None = None,
) -> dict:
    entry = {
        "id": uuid.uuid4().hex,
        "agentName": agent_name,
        "agentType": agent_type,
        "keywords": keywords,
        "location": location,
        "traits": traits,
        "behaviorToggles": behavior_toggles or [],
        "savedAt": int(time.time() * 1000),
    }
    _migrate()
    with db.write() as conn:
        # Same name+type+keywords+location saved again is a distinct-entry
        # repeat — collapse it, matching saved_searches.py's behaviour.
        for d in _load(conn):
            if (
                d.get("agentName") == agent_name
                and d.get("agentType") == agent_type
                and d.get("keywords") == keywords
                and d.get("location") == location
                and d.get("behaviorToggles", []) == (behavior_toggles or [])
            ):
                conn.execute("DELETE FROM agent_drafts WHERE id = ?", (d["id"],))
        _insert(conn, entry)
    return entry


def update_draft(
    draft_id: str,
    agent_name: str,
    agent_type: str | None,
    keywords: list,
    location: str,
    traits: list,
    behavior_toggles: list | None = None,
) -> dict | None:
    """Edits a saved profile in place (same id, moved to the top). Returns
    None when the id no longer exists, so the caller can fall back to add."""
    _migrate()
    with db.write() as conn:
        row = conn.execute("SELECT data FROM agent_drafts WHERE id = ?", (draft_id,)).fetchone()
        if row is None:
            return None
        entry = {
            **db.loads(row["data"]),
            "agentName": agent_name,
            "agentType": agent_type,
            "keywords": keywords,
            "location": location,
            "traits": traits,
            "behaviorToggles": behavior_toggles or [],
            "savedAt": int(time.time() * 1000),
        }
        # Delete + insert rather than UPDATE so seq (the list order) moves
        # it to the top, like a fresh save.
        conn.execute("DELETE FROM agent_drafts WHERE id = ?", (draft_id,))
        _insert(conn, entry)
    return entry


def delete_draft(draft_id: str) -> None:
    _migrate()
    with db.write() as conn:
        conn.execute("DELETE FROM agent_drafts WHERE id = ?", (draft_id,))
