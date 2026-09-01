"""
Shared LLM client: cascades across configured providers so a cloud outage,
exhausted quota, or missing key doesn't take the agent down, and so local-only
development (zero API cost) is a one-line env change.

Mirrors ChattyPrayers.Api's LlmCascadeService pattern: try providers in
priority order, log every failure (so silent fallbacks stay visible), fall
through to the next on any error.

Order: Gemini (cheap, cloud) -> Ollama (free, local-only, must be running on
the same machine as the caller — this only ever succeeds for `sam local` /
`backend/server.py` dev, never a deployed Lambda, which cannot reach a
developer's localhost).

Env vars:
  GEMINI_API_KEY   - required to use Gemini at all; if unset, Gemini is skipped
  OLLAMA_BASE_URL  - default http://localhost:11434/v1
  OLLAMA_MODEL     - default qwen2.5 (solid tool-calling/JSON compliance for its size)
  LLM_PROVIDER     - "gemini" or "ollama" to force a single provider instead of
                     cascading (e.g. LLM_PROVIDER=ollama for offline/no-cost dev)
"""
import logging
import os
import requests
from openai import OpenAI

logger = logging.getLogger(__name__)

GEMINI_MODEL = "gemini-3.6-flash"
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5")
# Native Ollama API (for /api/tags — model listing isn't part of the OpenAI-compatible surface)
OLLAMA_HOST = OLLAMA_BASE_URL.removesuffix("/v1").removesuffix("/")

_gemini_client = OpenAI(
    api_key=os.environ.get("GEMINI_API_KEY") or "unset",
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
)
_ollama_client = OpenAI(
    api_key="ollama",  # unused by Ollama but required by the OpenAI SDK's constructor
    base_url=OLLAMA_BASE_URL,
)

# (provider name, client, model) in cascade priority order
_PROVIDERS = [
    ("gemini", _gemini_client, GEMINI_MODEL),
    ("ollama", _ollama_client, OLLAMA_MODEL),
]


def create_chat_completion(provider: str | None = None, model: str | None = None, _meta: dict | None = None, **kwargs):
    """
    Drop-in replacement for `client.chat.completions.create(...)`. Do not pass
    `model` as a plain kwarg — use the `model` parameter below instead.

    `provider`, when given ("gemini" or "ollama"), forces that single provider
    for this call — e.g. a per-agent choice made on the Setup screen and carried
    in AgentConfig. Falls back to the LLM_PROVIDER env var, then the full cascade.

    `model` overrides the default model for whichever provider ends up serving
    the call (currently only meaningful for "ollama" — e.g. trying llama3.2 or
    qwen2.5-coder instead of the OLLAMA_MODEL default; Gemini's model is fixed).

    `_meta`, when given, is populated in place with which provider actually
    served the call (or attempted to) so a caller can report it to the user —
    e.g. bootstrap.py's streaming progress feed. Optional and backward
    compatible: existing callers that don't pass it see no change in behaviour.
      _meta["used"]   = {"provider": ..., "model": ...} on success, None if every
                        provider failed
      _meta["failed"] = [{"provider": ..., "model": ...}, ...] for every
                        provider that was tried and failed before either a
                        success or total failure

    Raises RuntimeError only if every eligible provider fails.
    """
    forced = (provider or os.environ.get("LLM_PROVIDER", "")).strip().lower()
    providers = [p for p in _PROVIDERS if p[0] == forced] if forced else _PROVIDERS

    last_error = None
    for name, client, default_model in providers:
        if name == "gemini" and not os.environ.get("GEMINI_API_KEY"):
            logger.info("Skipping gemini: GEMINI_API_KEY not set")
            continue
        use_model = model if (model and name == "ollama") else default_model
        try:
            response = client.chat.completions.create(model=use_model, **kwargs)
            if last_error is not None:
                logger.warning("LLM provider %s failed (%s); fell back to %s", last_error[0], last_error[1], name)
            if _meta is not None:
                _meta["used"] = {"provider": name, "model": use_model}
            return response
        except Exception as e:
            logger.warning("LLM provider %s (%s) failed: %s", name, use_model, e)
            if _meta is not None:
                _meta.setdefault("failed", []).append({"provider": name, "model": use_model})
            last_error = (name, e)

    if _meta is not None:
        _meta["used"] = None
    raise RuntimeError(f"All LLM providers failed. Last error: {last_error}")


def list_ollama_models() -> list[str]:
    """
    Names of models currently pulled in the local Ollama install (via its
    native /api/tags — the OpenAI-compatible surface has no listing endpoint).
    Returns [] on any failure (Ollama not running, unreachable, etc.) rather
    than raising — the Setup screen just shows an empty picker in that case,
    since this only ever matters for local dev in the first place.
    """
    try:
        resp = requests.get(f"{OLLAMA_HOST}/api/tags", timeout=3)
        resp.raise_for_status()
        return sorted(m["name"] for m in resp.json().get("models", []))
    except Exception as e:
        logger.info("Could not list Ollama models: %s", e)
        return []
