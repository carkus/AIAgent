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

# Small tie-breaker weight (not a re-ranking override) added to a candidate's
# cosine-similarity score when it matches a published agent's own
# persona-name+toolset signature — "teach conventions, then favor past
# examples that became successful published agents" per the user's stated
# direction, without a schema migration to stored entries (this is a live
# cross-reference against agent_registry.py/eval_log.py at query time).
_SUCCESS_BOOST_WEIGHT = 0.15


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


def record(
    purpose: str, config: dict, provider: str | None, is_worker: bool = False,
    agent_type: str | None = None,
) -> None:
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
            "agent_type": agent_type,
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


def _signature(persona: dict | None, tool_names: list) -> tuple | None:
    if not persona or not persona.get("name"):
        return None
    return (persona.get("name"), frozenset(n for n in tool_names if n))


def _apply_success_boost(scored: list[tuple[float, dict]]) -> list[tuple[float, dict]]:
    """Best-effort, self-contained: on any failure (registry unreadable,
    eval_log unreadable, import error), returns `scored` unchanged so plain
    cosine-similarity ordering is always the safe fallback."""
    try:
        import agent_registry
        import agent_stats

        agents = agent_registry.list_agents()
        sig_to_agent_id = {}
        for a in agents:
            config = a.get("agent_config") or {}
            tools = [t for t in config.get("tools", []) if isinstance(t, dict)]
            sig = _signature(config.get("persona"), [t.get("name") for t in tools])
            if sig is not None:
                sig_to_agent_id[sig] = a["id"]

        if not sig_to_agent_id:
            return scored

        rates = agent_stats.stats_for_agents(list(sig_to_agent_id.values()))

        boosted = []
        for score, entry in scored:
            sig = _signature(entry.get("persona"), entry.get("tool_names") or [])
            agent_id = sig_to_agent_id.get(sig) if sig is not None else None
            rate = rates[agent_id]["rate"] if agent_id is not None else None
            if rate is not None:
                score = score + _SUCCESS_BOOST_WEIGHT * rate
            boosted.append((score, entry))
        return boosted
    except Exception as e:
        logger.info("bootstrap_memory success-boost skipped: %s", e)
        return scored


def retrieve_similar(
    purpose: str, provider: str | None, is_worker: bool = False, k: int = 2, min_similarity: float = 0.6,
    agent_type: str | None = None,
) -> list[dict]:
    """Top-k past bootstrap entries whose purpose is most similar to `purpose`,
    restricted to the same is_worker bucket (a top-level user purpose and a
    narrow delegated subtask aren't good few-shot matches for each other) and,
    when the caller knows it, the same agent_type (research/job_search/
    general) — a "research" purpose can be semantically close enough to a
    past "job_search" purpose to pass the similarity threshold, which used to
    hand back a job-search example that a research agent would then copy
    wholesale. Entries recorded before this field existed have no agent_type
    and are simply excluded from a type-scoped query rather than guessed at.
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
            if agent_type is not None and entry.get("agent_type") != agent_type:
                continue
            embedding = entry.get("embedding")
            if not embedding:
                continue
            score = cosine_similarity(query_embedding, embedding)
            if score >= min_similarity:
                scored.append((score, entry))

        scored = _apply_success_boost(scored)
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [entry for _, entry in scored[:k]]
    except Exception as e:
        logger.info("bootstrap_memory.retrieve_similar skipped: %s", e)
        return []
