"""
Self-evaluation log (root CLAUDE.md eval-framework task): an append-only
organic record of every check `eval_checks.py` ever runs, across all four
session stages (bootstrap, chat response, tool call, worker delegation).

Storage shape mirrors bootstrap_memory.py exactly: a single JSON file under
DATA_DIR, threading.Lock around plain read/write, atomic replace on save,
FIFO-capped. Higher cap than bootstrap_memory's 200 since a single chat turn
can emit several check results (one per tool call plus one for the response),
not just one per bootstrap.

record() is best-effort and never raises past its own boundary — this is
background instrumentation, not a user-facing action, so a disk hiccup here
must never surface as a broken /bootstrap or /agent request.
"""
import json
import logging
import os
import threading
import time
import uuid

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_MAX_ENTRIES = 500


def _data_path() -> str:
    data_dir = os.environ.get("DATA_DIR", os.getcwd())
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "eval_results.json")


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


def _save(entries: list) -> None:
    path = _data_path()
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(entries, f)
    os.replace(tmp_path, path)


def record(result: dict) -> None:
    """Best-effort: append one eval_checks result dict to the log. Swallows
    every failure — called alongside/after a check has already been computed,
    so nothing here should ever surface as an error to the caller."""
    try:
        entry = dict(result)
        entry["id"] = uuid.uuid4().hex
        entry["timestamp"] = time.time()

        with _lock:
            entries = _load()
            entries.append(entry)
            if len(entries) > _MAX_ENTRIES:
                entries = entries[-_MAX_ENTRIES:]
            _save(entries)
    except Exception as e:
        logger.info("eval_log.record skipped: %s", e)


def list_recent(limit: int = 100) -> list[dict]:
    """Most recent entries first. Returns [] on any failure."""
    try:
        with _lock:
            entries = _load()
        return list(reversed(entries[-limit:]))
    except Exception as e:
        logger.info("eval_log.list_recent skipped: %s", e)
        return []
