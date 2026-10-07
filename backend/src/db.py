"""
Shared SQLite storage for every server-side store (eval_log, bootstrap_memory,
agent_registry, agent_drafts, saved_searches, rate_limit).

Why SQLite replaced the per-store JSON files: each JSON store guarded its
read-modify-write with a threading.Lock, which only serialises threads inside
ONE process. Two processes already write the same data — gunicorn (server.py)
and the separate MCP server (mcp_server.py), which runs agents and so records
eval results and worker bootstraps — so concurrent writes could silently drop
each other's updates (last writer wins). It also pinned gunicorn to
--workers 1. SQLite locks across processes, so any number of workers and the
MCP server can share one database file safely.

Still a single file under DATA_DIR (agentone.db) — no server to run, nothing
extra resident in memory, stdlib only. WAL mode lets readers proceed while a
writer commits; busy_timeout makes a second writer wait briefly instead of
failing with "database is locked".

Records are stored as a JSON `data` column plus whichever columns are
queried or ordered on. Every store's public functions return exactly the same
dict shapes and orderings as the JSON versions did, so callers are unchanged.
`seq` (AUTOINCREMENT, never reused) preserves insertion order.

Migration: the first time a store's table is opened and the old JSON file
exists, its contents are imported in their original order and the file is
renamed to <name>.json.migrated (kept, not deleted, so a rollback is just a
rename back). Runs inside a write transaction recorded in `migrations`, so
gunicorn and the MCP server starting together import it exactly once.
"""
import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_DB_FILENAME = "agentone.db"
_BUSY_TIMEOUT_MS = 10000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    done_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_results (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    agent_id TEXT,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS eval_results_agent_id ON eval_results(agent_id);
CREATE TABLE IF NOT EXISTS bootstrap_memory (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_registry (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    tool_name TEXT UNIQUE NOT NULL,
    agent_config_id TEXT,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_registry_config_id ON agent_registry(agent_config_id);
CREATE TABLE IF NOT EXISTS agent_drafts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_searches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limit_hits (
    client_id TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_client_ts ON rate_limit_hits(client_id, ts);
CREATE INDEX IF NOT EXISTS rate_limit_hits_ts ON rate_limit_hits(ts);
"""

_local = threading.local()
_init_lock = threading.Lock()
_initialised: set[str] = set()
_migrated: set[tuple[str, str]] = set()


def data_dir() -> str:
    path = os.environ.get("DATA_DIR", os.getcwd())
    os.makedirs(path, exist_ok=True)
    return path


def _db_path() -> str:
    return os.path.join(data_dir(), _DB_FILENAME)


def _connect(path: str) -> sqlite3.Connection:
    # isolation_level=None: autocommit, with transactions opened explicitly
    # by write() below, so BEGIN IMMEDIATE is under our control.
    conn = sqlite3.connect(path, timeout=_BUSY_TIMEOUT_MS / 1000, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def _connection() -> sqlite3.Connection:
    """One connection per thread per database path (sqlite3 connections
    aren't shareable across threads; keyed by path so a changed DATA_DIR,
    e.g. in tests, gets a fresh database)."""
    path = _db_path()
    conns = getattr(_local, "conns", None)
    if conns is None:
        conns = _local.conns = {}
    conn = conns.get(path)
    if conn is None:
        conn = conns[path] = _connect(path)
    if path not in _initialised:
        with _init_lock:
            if path not in _initialised:
                conn.executescript(_SCHEMA)
                _initialised.add(path)
    return conn


@contextmanager
def read():
    yield _connection()


@contextmanager
def write():
    """A write transaction. BEGIN IMMEDIATE takes the write lock up front,
    so a read-modify-write inside it can't interleave with another
    process's — the guarantee the old threading.Lock only gave per process."""
    conn = _connection()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def loads(text: str):
    return json.loads(text)


def migrate_json_store(name: str, json_filename: str, insert_rows) -> None:
    """One-time import of a legacy JSON-list store. `insert_rows(conn, items)`
    inserts the list in its original on-disk order; each store knows whether
    that list was oldest-first or newest-first. Best-effort: a missing or
    unreadable file just marks the migration done with nothing imported."""
    key = (_db_path(), name)
    if key in _migrated:
        return
    with read() as conn:
        if conn.execute("SELECT 1 FROM migrations WHERE name = ?", (name,)).fetchone():
            _migrated.add(key)
            return
    json_path = os.path.join(data_dir(), json_filename)
    with write() as conn:
        if conn.execute("SELECT 1 FROM migrations WHERE name = ?", (name,)).fetchone():
            return
        items = []
        if os.path.exists(json_path):
            try:
                with open(json_path, encoding="utf-8") as f:
                    loaded = json.load(f)
                items = [i for i in loaded if isinstance(i, dict)] if isinstance(loaded, list) else []
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("db: could not read %s for migration (%s); starting empty", json_path, e)
        if items:
            insert_rows(conn, items)
        conn.execute("INSERT INTO migrations (name, done_at) VALUES (?, ?)", (name, time.time()))
    if os.path.exists(json_path):
        try:
            os.replace(json_path, json_path + ".migrated")
        except OSError as e:
            logger.warning("db: imported %s but could not rename it: %s", json_path, e)
    _migrated.add(key)
    if items:
        logger.info("db: migrated %d %s entries from %s", len(items), name, json_filename)
