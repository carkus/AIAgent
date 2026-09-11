"""
Bootstrap grounding store (CLAUDE.md RAG priority 5): "embed every
purpose -> generated config pair after a successful bootstrap, and retrieve
the nearest past purposes + their working tool schemas as few-shot examples
for new bootstraps."

Storage shape mirrors saved_searches.py: a single JSON file under DATA_DIR,
threading.Lock around plain read/write (single gunicorn worker in production,
see that module's docstring for why that's sufficient), atomic replace on
save. Retrieval is an in-memory linear cosine-similarity scan over stored
embeddings (embeddings.py) — no vector-DB dependency, same shape as
ChattyPrayers.Api's ConversationIndex, proportionate to at most a few hundred
stored entries (FIFO-capped below).

Every public function here is best-effort and never raises past its own
boundary: a broken/unavailable embedding provider or a disk hiccup should
degrade bootstrap back to today's cold-start behavior, not fail it.
"""
import json
import logging
import os
import threading
import time
import uuid

from embeddings import embed_text, cosine_similarity

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_MAX_ENTRIES = 200
_SYSTEM_PROMPT_EXCERPT_LEN = 300


def _data_path() -> str:
    data_dir = os.environ.get("DATA_DIR", os.getcwd())
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "bootstrap_memory.json")


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


def record(purpose: str, config: dict, provider: str | None, is_worker: bool = False) -> None:
    """Best-effort: embed `purpose` and store a compact summary of `config`
    for future few-shot retrieval. Swallows every failure — called after
    bootstrap has already produced a valid response, so nothing here should
    ever surface as an error to the caller."""
    try:
        embedding = embed_text(purpose, provider)
        if embedding is None:
            return

        persona = config.get("persona") or {}
        tools = [t for t in config.get("tools", []) if isinstance(t, dict)]
        entry = {
            "id": uuid.uuid4().hex,
            "purpose": purpose,
            "is_worker": is_worker,
            "embedding": embedding,
            "persona": {
                "name": persona.get("name"),
                "traits": persona.get("traits", []),
            } if persona else None,
            "tool_names": [t.get("name") for t in tools],
            "tool_descriptions": [
                {"name": t.get("name"), "description": t.get("description")} for t in tools
            ],
            "system_prompt_excerpt": (config.get("system_prompt") or "")[:_SYSTEM_PROMPT_EXCERPT_LEN],
            "created_at": time.time(),
        }

        with _lock:
            entries = _load()
            entries.append(entry)
            if len(entries) > _MAX_ENTRIES:
                entries = entries[-_MAX_ENTRIES:]
            _save(entries)
    except Exception as e:
        logger.info("bootstrap_memory.record skipped: %s", e)


def retrieve_similar(
    purpose: str, provider: str | None, is_worker: bool = False, k: int = 2, min_similarity: float = 0.6
) -> list[dict]:
    """Top-k past bootstrap entries whose purpose is most similar to `purpose`,
    restricted to the same is_worker bucket (a top-level user purpose and a
    narrow delegated subtask aren't good few-shot matches for each other).
    Returns [] on any failure, including "no embedding provider available" —
    that's the expected, silent path for the very first bootstraps."""
    try:
        query_embedding = embed_text(purpose, provider)
        if query_embedding is None:
            return []

        with _lock:
            entries = _load()

        scored = []
        for entry in entries:
            if entry.get("is_worker", False) != is_worker:
                continue
            embedding = entry.get("embedding")
            if not embedding:
                continue
            score = cosine_similarity(query_embedding, embedding)
            if score >= min_similarity:
                scored.append((score, entry))

        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [entry for _, entry in scored[:k]]
    except Exception as e:
        logger.info("bootstrap_memory.retrieve_similar skipped: %s", e)
        return []
