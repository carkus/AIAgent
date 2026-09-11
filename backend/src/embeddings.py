"""
Text embeddings for bootstrap grounding (CLAUDE.md RAG priority 5).

Mirrors ChattyPrayers.Api's EmbeddingService/ConversationIndex pattern: no
vector-DB dependency, just a provider call that returns a float vector and an
inline cosine similarity used for a linear in-memory scan (see
bootstrap_memory.py) — proportionate to this project's scale (at most a few
hundred stored bootstraps).

Unlike ChattyPrayers.Api (which only has an Ollama embedding path), AIAgent's
production is Gemini-only (see CLAUDE.md Deployment), so this also has to work
without Ollama: Gemini's OpenAI-compatible surface serves embeddings at the
same base_url llm_client.py already uses for chat completions
(https://ai.google.dev/gemini-api/docs/openai), so the existing `openai` SDK
client covers both.

Every function here is best-effort: on any failure (no API key, network
error, Ollama not running, model not pulled) they return None rather than
raising. Callers (bootstrap_memory.py) must treat that as "skip RAG for this
call" — grounding is a quality improvement, never a hard dependency for
bootstrap to function.
"""
import logging
import math
import requests

from llm_client import _gemini_client, GEMINI_EMBED_MODEL, OLLAMA_HOST

logger = logging.getLogger(__name__)

OLLAMA_EMBED_MODEL = "nomic-embed-text"


def embed_text(text: str, provider: str | None = None) -> list[float] | None:
    """
    Embed `text` using whichever provider the caller's agent is configured
    for — "ollama" uses the local Ollama install (dev-only, same as the rest
    of the Ollama path), anything else (including None, the default) uses
    Gemini so this works in production too.
    """
    if not text or not text.strip():
        return None
    if provider == "ollama":
        return _embed_ollama(text)
    return _embed_gemini(text)


def _embed_gemini(text: str) -> list[float] | None:
    try:
        response = _gemini_client.embeddings.create(model=GEMINI_EMBED_MODEL, input=text)
        return list(response.data[0].embedding)
    except Exception as e:
        logger.info("Gemini embedding failed: %s", e)
        return None


def _embed_ollama(text: str) -> list[float] | None:
    try:
        resp = requests.post(
            f"{OLLAMA_HOST}/api/embed",
            json={"model": OLLAMA_EMBED_MODEL, "input": text},
            timeout=10,
        )
        resp.raise_for_status()
        embeddings = resp.json().get("embeddings")
        if not embeddings:
            return None
        return list(embeddings[0])
    except Exception as e:
        logger.info("Ollama embedding failed: %s", e)
        return None


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
