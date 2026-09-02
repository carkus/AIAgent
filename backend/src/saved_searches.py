"""
Server-side persistence for Setup screen "saved searches".

Previously these lived in the browser's localStorage, which is scoped per
origin (protocol+host+port) — every dev-server port change silently handed
the user a brand-new, empty storage bucket. This module replaces that with a
small JSON-file-backed store so saved searches survive port/browser changes.

Storage path is resolved from the DATA_DIR env var (set by server.py from its
existing _ROOT computation) rather than recomputed here, and deliberately
lives outside backend/ — see deploy/redeploy.sh's deploy_backend(), which
tars and overwrites the entire backend/ directory on every deploy.

Single gunicorn worker in production (see deploy/aiagent.service), so a
threading.Lock() around plain file reads/writes is sufficient — no
multi-process race to worry about.
"""

import json
import os
import threading
import uuid

_lock = threading.Lock()


def _data_path() -> str:
    data_dir = os.environ.get("DATA_DIR", os.getcwd())
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "saved_searches.json")


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


def _save(searches: list) -> None:
    path = _data_path()
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(searches, f, indent=2)
    os.replace(tmp_path, path)


def list_searches() -> list:
    with _lock:
        return _load()


def add_search(name: str, keywords: list, agent_type: str | None) -> dict:
    entry = {
        "id": uuid.uuid4().hex,
        "name": name,
        "keywords": keywords,
        "agentType": agent_type,
    }
    with _lock:
        searches = _load()
        # Same keywords saved under the same agent type is a distinct-entry
        # repeat — collapse it, matching the old localStorage behaviour.
        searches = [s for s in searches if not (s.get("name") == name and s.get("agentType") == agent_type)]
        searches.insert(0, entry)
        _save(searches)
    return entry


def delete_search(search_id: str) -> None:
    with _lock:
        searches = _load()
        searches = [s for s in searches if s.get("id") != search_id]
        _save(searches)
