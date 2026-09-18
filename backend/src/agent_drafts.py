"""
Server-side persistence for Setup screen "saved agent profiles" — the
pre-bootstrap draft (agent name, type, location, specialties) captured by the
"Save Agent" button, distinct from "Select Specialties" (keywords only, see
saved_searches.py) and from a "Saved Agent" chat (a fully bootstrapped agent
with real conversation history, see chatStorage.ts). No system prompt/tools
exist yet at this stage — that only happens once the draft is commissioned.

Same JSON-file-backed, lock/atomic-replace pattern as saved_searches.py.
"""

import json
import os
import threading
import time
import uuid

_lock = threading.Lock()


def _data_path() -> str:
    data_dir = os.environ.get("DATA_DIR", os.getcwd())
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "agent_drafts.json")


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


def _save(drafts: list) -> None:
    path = _data_path()
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(drafts, f, indent=2)
    os.replace(tmp_path, path)


def list_drafts() -> list:
    with _lock:
        return _load()


def add_draft(agent_name: str, agent_type: str | None, keywords: list, location: str, traits: list) -> dict:
    entry = {
        "id": uuid.uuid4().hex,
        "agentName": agent_name,
        "agentType": agent_type,
        "keywords": keywords,
        "location": location,
        "traits": traits,
        "savedAt": int(time.time() * 1000),
    }
    with _lock:
        drafts = _load()
        # Same name+type+keywords+location saved again is a distinct-entry
        # repeat — collapse it, matching saved_searches.py's behaviour.
        drafts = [
            d for d in drafts
            if not (
                d.get("agentName") == agent_name
                and d.get("agentType") == agent_type
                and d.get("keywords") == keywords
                and d.get("location") == location
            )
        ]
        drafts.insert(0, entry)
        _save(drafts)
    return entry


def delete_draft(draft_id: str) -> None:
    with _lock:
        drafts = _load()
        drafts = [d for d in drafts if d.get("id") != draft_id]
        _save(drafts)
