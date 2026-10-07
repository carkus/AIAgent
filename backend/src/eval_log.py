"""
Self-evaluation log (root CLAUDE.md eval-framework task): an append-only
organic record of every check `eval_checks.py` ever runs, across all four
session stages (bootstrap, chat response, tool call, worker delegation).

Stored in the shared SQLite database (db.py, table eval_results) — written by
both gunicorn and the MCP server process, which is why it moved off a
JSON file + threading.Lock. FIFO-capped. Higher cap than bootstrap_memory's
200 since a single chat turn can emit several check results (one per tool
call plus one for the response), not just one per bootstrap.

record() is best-effort and never raises past its own boundary — this is
background instrumentation, not a user-facing action, so a disk hiccup here
must never surface as a broken /bootstrap or /agent request.
"""
import logging
import time
import uuid

import db

logger = logging.getLogger(__name__)

_MAX_ENTRIES = 500


def _insert(conn, entry: dict) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO eval_results (id, agent_id, data) VALUES (?, ?, ?)",
        (entry["id"], entry.get("agent_id"), db.dumps(entry)),
    )


def _migrate() -> None:
    # eval_results.json was stored oldest first.
    def insert_rows(conn, items):
        for item in items:
            item.setdefault("id", uuid.uuid4().hex)
            _insert(conn, item)
    db.migrate_json_store("eval_results", "eval_results.json", insert_rows)


def record(result: dict) -> None:
    """Best-effort: append one eval_checks result dict to the log. Swallows
    every failure — called alongside/after a check has already been computed,
    so nothing here should ever surface as an error to the caller."""
    try:
        _migrate()
        entry = dict(result)
        entry["id"] = uuid.uuid4().hex
        entry["timestamp"] = time.time()

        with db.write() as conn:
            _insert(conn, entry)
            conn.execute(
                "DELETE FROM eval_results WHERE seq <= "
                "(SELECT seq FROM eval_results ORDER BY seq DESC LIMIT 1 OFFSET ?)",
                (_MAX_ENTRIES,),
            )
    except Exception as e:
        logger.info("eval_log.record skipped: %s", e)


def list_recent(limit: int = 100) -> list[dict]:
    """Most recent entries first. Returns [] on any failure."""
    try:
        _migrate()
        with db.read() as conn:
            rows = conn.execute(
                "SELECT data FROM eval_results ORDER BY seq DESC LIMIT ?", (limit,)
            ).fetchall()
        return [db.loads(r["data"]) for r in rows]
    except Exception as e:
        logger.info("eval_log.list_recent skipped: %s", e)
        return []


def list_all() -> list[dict]:
    """Every stored entry (up to _MAX_ENTRIES), oldest first. Unlike
    list_recent(), not capped by a caller-supplied limit — used by bandit.py
    to compute per-arm pull/success counts across the full retained history.
    Returns [] on any failure."""
    try:
        _migrate()
        with db.read() as conn:
            rows = conn.execute("SELECT data FROM eval_results ORDER BY seq").fetchall()
        return [db.loads(r["data"]) for r in rows]
    except Exception as e:
        logger.info("eval_log.list_all skipped: %s", e)
        return []
