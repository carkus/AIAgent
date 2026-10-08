import logging
import os
import traceback
import builtins

import llm_client

logger = logging.getLogger(__name__)

# Generated tool implementations get the raw `requests` module (see
# execute_tool below) and the bootstrap prompt doesn't mandate a timeout on
# every call a model writes — unlike fetch_page/search_jobs/search_image
# above, which all hardcode one. A generated `requests.get(url)` with no
# timeout against an unresponsive host previously hung this exec() call, and
# with it the whole synchronous agent loop, forever — indistinguishable from
# the agent simply never responding. _TimeoutRequests defaults `timeout=` to
# this value on every HTTP-verb call the generated code makes, only when it
# didn't already pass its own.
DEFAULT_TOOL_HTTP_TIMEOUT_SECONDS = float(os.environ.get("TOOL_HTTP_TIMEOUT_SECONDS", "20"))
_HTTP_METHODS = ("get", "post", "put", "delete", "patch", "head", "options", "request")


class _TimeoutRequests:
    """Proxy over the `requests` module for exec()'d generated tool code —
    same module surface (requests.get, requests.exceptions.Timeout, etc.),
    except the HTTP-verb functions get a default timeout injected."""

    def __init__(self, module, default_timeout):
        self._module = module
        self._default_timeout = default_timeout

    def __getattr__(self, name):
        attr = getattr(self._module, name)
        if name in _HTTP_METHODS and callable(attr):
            def wrapped(*args, **kwargs):
                kwargs.setdefault("timeout", self._default_timeout)
                return attr(*args, **kwargs)
            return wrapped
        return attr


# Allowlist of safe builtins for tool execution.
# open is included so save_output tools can write to /tmp.
# __import__ is included so tool code can import standard-library modules;
# requests, json, and os are pre-injected and don't need importing.
_SAFE_BUILTINS = {
    name: getattr(builtins, name)
    for name in (
        "print", "len", "range", "enumerate", "zip", "map", "filter",
        "sorted", "reversed", "list", "dict", "set", "tuple", "str",
        "int", "float", "bool", "type", "isinstance", "hasattr", "getattr",
        "min", "max", "sum", "abs", "round", "repr", "format",
        "any", "all", "next", "iter", "hash", "id",
        "open", "__import__", "dir", "vars", "globals", "locals", "callable",
        "Exception", "ValueError", "KeyError", "TypeError", "IOError",
        "StopIteration", "RuntimeError", "IndexError", "AttributeError",
    )
}


def fetch_page(url: str) -> dict:
    """Built-in primitive: fetch a URL and return clean text (HTML stripped)."""
    import requests
    import re
    from html.parser import HTMLParser

    # Tags that block ALL their inner content (including nested children).
    # Uses a stack so nesting is handled correctly.
    BLOCK = {
        'script', 'style', 'noscript',   # code / css
        'head',                            # document metadata
        'svg', 'canvas',                   # graphics (SVG paths are noise)
        'nav', 'header', 'footer', 'aside',# page chrome
        'form', 'select', 'option',        # form controls
    }
    # Tags whose start tag we simply ignore (no content to skip, void elements)
    VOID = {'meta', 'link', 'input', 'br', 'hr', 'img', 'button'}

    class _Extractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts: list[str] = []
            self._stack: list[str] = []   # stack of currently-blocked tags

        def handle_starttag(self, tag, attrs):
            t = tag.lower()
            if t in BLOCK:
                self._stack.append(t)

        def handle_endtag(self, tag):
            t = tag.lower()
            # Pop only if this tag is on the top of our block stack
            if self._stack and self._stack[-1] == t:
                self._stack.pop()

        def handle_data(self, data):
            if not self._stack:
                text = data.strip()
                if text:
                    self.parts.append(text)

    headers = {
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/124.0.0.0 Safari/537.36'
        ),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
    }

    try:
        r = requests.get(url, headers=headers, timeout=20, allow_redirects=True)
        ex = _Extractor()
        ex.feed(r.text)
        text = '\n'.join(ex.parts)
        text = re.sub(r'\n{3,}', '\n\n', text)

        # Extract listing count from page text (e.g. "430 software engineer jobs in Melbourne")
        count_match = re.search(r'\b(\d[\d,]*)\s+(?:\w+\s+){0,5}?jobs?\b', text[:2000], re.IGNORECASE)
        listing_count = None
        if count_match:
            n = int(count_match.group(1).replace(',', ''))
            if n > 0:
                listing_count = n

        limit = 20000
        return {
            'status_code': r.status_code,
            'url': str(r.url),
            'content': text[:limit],
            'char_count': len(text),
            'truncated': len(text) > limit,
            'listing_count': listing_count,
        }
    except Exception as exc:
        return {'error': str(exc), 'url': url}


# Adzuna's own default (no "distance" param sent at all) doesn't meaningfully
# bound results to "where" — it falls back to a loose text match that pulls in
# listings well outside the named place, which is the "results beyond the
# assigned location" bug this constant fixes. Applied automatically below
# whenever a location is given but the caller (the model) didn't also think
# to specify a radius, which is the common case — a job-search prompt asking
# for "jobs in Melbourne" has no reason to know Adzuna even has a distance
# param, let alone remember to set it every time.
_DEFAULT_DISTANCE_KM = 15


def search_jobs(what: str, where: str = "", country: str = "au",
                 results_per_page: int = 20, page: int = 1,
                 distance_km: int | None = None) -> dict:
    """
    Built-in primitive: real job search via Adzuna's Job Search API
    (https://developer.adzuna.com/), not scraping. Exists because fetch_page
    against SEEK/Indeed reliably 403s from the droplet's datacenter IP —
    real bot-management, not something a spoofed User-Agent gets past.

    Requires ADZUNA_APP_ID / ADZUNA_APP_KEY env vars (free tier at
    developer.adzuna.com). Returns {"status": "no_credentials", ...} if unset
    so the agent can tell the user rather than fail silently.

    Response shape matches what ToolActivity.tsx's normaliseJobData/JobCard
    already render: {listings: [...], total_count, mean_salary}.
    """
    import requests
    import os

    app_id = os.environ.get("ADZUNA_APP_ID")
    app_key = os.environ.get("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        return {
            "status": "no_credentials",
            "message": (
                "ADZUNA_APP_ID/ADZUNA_APP_KEY are not configured, so live job "
                "search is unavailable. Sign up free at developer.adzuna.com."
            ),
        }

    page = max(1, page)
    url = f"https://api.adzuna.com/v1/api/jobs/{country}/search/{page}"
    params = {
        "app_id": app_id,
        "app_key": app_key,
        "results_per_page": min(max(results_per_page, 1), 50),
        "what": what,
        "content-type": "application/json",
    }
    if where:
        params["where"] = where
        # Adzuna's "distance" param (km) only does anything alongside "where"
        # — a radius with no center point to measure from is meaningless to
        # their API — so it's only ever set in this branch. Falls back to
        # _DEFAULT_DISTANCE_KM rather than leaving it unset whenever the
        # caller names a location without also specifying a radius, since an
        # unset distance is effectively unbounded on Adzuna's side.
        params["distance"] = distance_km if distance_km else _DEFAULT_DISTANCE_KM

    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return {"status_code": r.status_code, "error": r.text[:500], "listings": []}

        data = r.json()
        listings = []
        for job in data.get("results", []):
            company = job.get("company") or {}
            location = job.get("location") or {}
            category = job.get("category") or {}
            listings.append({
                "title": job.get("title"),
                "company": company.get("display_name"),
                "location": location.get("display_name"),
                "salary_min": job.get("salary_min"),
                "salary_max": job.get("salary_max"),
                "redirect_url": job.get("redirect_url"),
                "description": job.get("description"),
                "created": job.get("created"),
                "contract_type": job.get("contract_type"),
                "category": category.get("label"),
            })

        return {
            "status_code": r.status_code,
            "total_count": data.get("count"),
            "returned": len(listings),
            "mean_salary": data.get("mean"),
            "listings": listings,
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc), "listings": []}


def _search_image_tavily(query: str) -> dict:
    """
    Web image search via Tavily's REST search API with include_images — the
    same TAVILY_API_KEY that enables the vetted Tavily MCP server
    (mcp_registry.py). Called directly over HTTP rather than through the MCP
    server, since search_image is a primitive and the MCP path only exists
    for bootstrap-selected tools. Covers generic subjects ("a modern
    kitchen") that have no Wikipedia article. Returns {"error": ...} when
    not configured or nothing comes back.
    """
    key = os.environ.get("TAVILY_API_KEY")
    if not key:
        return {"error": "TAVILY_API_KEY is not configured."}

    import requests
    from urllib.parse import urlparse

    try:
        r = requests.post(
            "https://api.tavily.com/search",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "query": query,
                "max_results": 3,
                "include_images": True,
                "include_image_descriptions": True,
            },
            timeout=15,
        )
        if not r.ok:
            return {"error": f"Tavily returned status {r.status_code}: {r.text[:200]}"}
        images = r.json().get("images") or []
    except Exception as exc:
        return {"error": str(exc)}

    # Strings without include_image_descriptions, {url, description} with it.
    candidates = []
    for image in images:
        url = image.get("url") if isinstance(image, dict) else image
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        host = urlparse(url).netloc.lower()
        # Social-media crawler/redirect links don't render as an <img>.
        if any(s in host for s in ("instagram", "facebook", "fbcdn", "fbsbx", "tiktok")):
            continue
        description = image.get("description") if isinstance(image, dict) else None
        candidates.append((url, description))
    # Prefer a URL that is plainly an image file.
    candidates.sort(key=lambda c: not urlparse(c[0]).path.lower().endswith(
        (".jpg", ".jpeg", ".png", ".webp", ".gif")))
    for url, description in candidates:
        return {
            "title": description or query,
            "image_url": url,
            "page_url": None,
            "attribution": f"Web image ({urlparse(url).netloc}) via Tavily",
        }
    return {"error": f"No web image found for '{query}'."}


def search_image(query: str) -> dict:
    """
    Built-in primitive: find one real existing image for a topic. Tries a
    Tavily web image search first when TAVILY_API_KEY is set (any subject,
    but web images aren't necessarily freely licensed), then falls back to
    the Wikipedia lookup below (named topics only, freely licensed).
    """
    if os.environ.get("TAVILY_API_KEY"):
        found = _search_image_tavily(query)
        if "error" not in found:
            return found
        logger.warning("search_image: Tavily failed (%s), falling back to Wikipedia", found["error"])
    return _search_image_wikipedia(query)


def _search_image_wikipedia(query: str) -> dict:
    """
    Find one real, freely-licensed illustrative image for
    a topic via Wikipedia/Wikimedia's public REST API (no key required, same
    "free keyless lookup" shape as jobfit/ChattyPrayers.Api's Open-Meteo
    weather provider). Returns a single best-match thumbnail, not a gallery —
    this exists to illustrate a research finding, not to replace it.

    Two calls: opensearch to resolve `query` to a real article title, then
    the page/summary endpoint for that title's thumbnail. Returns
    {"error": ...} (never raises) when nothing matches or has no image, so
    the agent can say plainly that no image was found instead of fabricating
    one.
    """
    import requests

    headers = {"User-Agent": "AgentOne/1.0 (research assistant; contact via project repo)"}
    try:
        search = requests.get(
            "https://en.wikipedia.org/w/api.php",
            params={
                "action": "opensearch",
                "search": query,
                "limit": 1,
                "namespace": 0,
                "format": "json",
            },
            headers=headers,
            timeout=10,
        )
        titles = search.json()[1] if search.ok else []
        if not titles:
            return {"error": f"No matching topic found for '{query}'."}
        title = titles[0]

        summary = requests.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{requests.utils.quote(title)}",
            headers=headers,
            timeout=10,
        )
        if not summary.ok:
            return {"error": f"No image available for '{title}'."}
        data = summary.json()
        thumbnail = data.get("thumbnail") or {}
        image_url = thumbnail.get("source")
        if not image_url:
            return {"error": f"'{title}' has no illustrative image available."}

        return {
            "title": title,
            "image_url": image_url,
            "page_url": (data.get("content_urls") or {}).get("desktop", {}).get("page"),
            "attribution": "Wikipedia",
        }
    except Exception as exc:
        return {"error": str(exc)}


# Hugging Face's free-tier serverless Inference API. Needs a free HF token
# (huggingface.co/settings/tokens, no billing required) but is far more
# reliable than the alternative actually tried first during setup:
# pollinations.ai's anonymous/keyless endpoint, which turned out to
# intermittently demand an x402 crypto micropayment (a real `Payment-Required`
# response with USDC payment terms in the headers, not a soft rate-limit)
# even on requests that should've been free — roughly half of a live test
# burst got the payment wall regardless of retries, backoff, or model choice.
# A model needing a real (if free) account is the tradeoff for one that
# doesn't silently start charging.
#
# Host is router.huggingface.co, not the old api-inference.huggingface.co —
# that legacy host no longer resolves at all (HF migrated serverless
# inference behind a unified "Inference Providers" router). Model choice
# also isn't free-form: most well-known checkpoints (FLUX.1-schnell,
# FLUX.1-dev, SDXL, SD 1.5/2.1) now 410/400 as "deprecated"/"not supported
# by provider hf-inference" — live-queried via
# https://huggingface.co/api/models?pipeline_tag=text-to-image&inference_provider=hf-inference
# during setup, which currently returns exactly one working model.
_HF_IMAGE_MODEL = "stabilityai/stable-diffusion-3-medium-diffusers"
_HF_ROUTER_BASE_URL = "https://router.huggingface.co/hf-inference/models"
_HF_MAX_ATTEMPTS = 2


def _generate_image_huggingface(prompt: str) -> dict:
    """
    Free fallback for generate_image via Hugging Face's Inference API. No
    local model equivalent exists (unlike chat's Ollama cascade), so this is
    the closest thing — a cheap/free cloud path when Gemini isn't configured
    or fails.

    Returns raw image bytes on success; base64-encoded into a data: URI
    (matching the contract Gemini's own path already returns) rather than
    routed through a file-storage step this project doesn't have.

    A cold model returns 503 with an `estimated_time` (seconds until it's
    loaded) instead of an image — retried once after that wait rather than
    surfacing "not ready yet" as a hard failure, same one-retry shape used
    elsewhere in this project for a not-yet-valid response.
    """
    token = os.environ.get("HF_API_TOKEN")
    if not token:
        return {"error": "Image generation fallback requires HF_API_TOKEN, which is not configured."}

    import base64
    import time

    import requests

    url = f"{_HF_ROUTER_BASE_URL}/{_HF_IMAGE_MODEL}"
    headers = {"Authorization": f"Bearer {token}"}
    last_error = None
    for attempt in range(_HF_MAX_ATTEMPTS):
        try:
            r = requests.post(url, headers=headers, json={"inputs": prompt}, timeout=60)
        except Exception as exc:
            return {"error": str(exc)}

        content_type = r.headers.get("content-type", "")
        if r.ok and content_type.startswith("image/"):
            mime = content_type.split(";")[0]
            b64 = base64.b64encode(r.content).decode("ascii")
            return {"image_url": f"data:{mime};base64,{b64}", "prompt": prompt, "provider": "huggingface"}

        try:
            body = r.json()
        except ValueError:
            body = {}
        last_error = body.get("error") or f"Hugging Face returned status {r.status_code}"
        if r.status_code == 503 and attempt < _HF_MAX_ATTEMPTS - 1:
            time.sleep(min(body.get("estimated_time") or 10, 20))
            continue
        break
    return {"error": last_error}


def generate_image(prompt: str) -> dict:
    """
    Built-in primitive: create a brand-new image from a text description —
    the complement to search_image, which finds a real *existing* photo
    rather than creating one.

    Cascade: Gemini's image-generation model first (higher quality, requires
    GEMINI_API_KEY), falling back to Hugging Face's free-tier Inference API
    (requires HF_API_TOKEN, a free account — see _generate_image_huggingface
    for why pollinations.ai's keyless option was tried and rejected first)
    whenever Gemini isn't configured or the call fails — same
    priority-order-with-logged-fallback shape as llm_client.py's
    Gemini-to-Ollama chat cascade, closing what used to be a hard dead end
    ("Image generation is Gemini-only; there is no Ollama equivalent") with
    a free cloud fallback instead of a local one.

    Reuses the same OpenAI-compatible client llm_client.py already uses for
    chat and embeddings (llm_client._gemini_client) rather than adding a
    separate SDK dependency — Gemini's OpenAI-compat surface supports image
    output on chat.completions.create via modalities=["text", "image"].

    Returns {"image_url": ..., "prompt": prompt, "provider": "gemini" |
    "huggingface"} on success — embeddable directly in markdown with no
    file-storage step — or {"error": ...} (never raises) only if both the
    Gemini attempt (when configured) and the Hugging Face fallback fail (or
    neither is configured).
    """
    if os.environ.get("GEMINI_API_KEY"):
        try:
            response = llm_client._gemini_client.chat.completions.create(
                model=llm_client.GEMINI_IMAGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                modalities=["text", "image"],
                timeout=llm_client.GEMINI_TIMEOUT_SECONDS,
            )
            images = getattr(response.choices[0].message, "images", None) or []
            if images:
                return {"image_url": images[0]["image_url"]["url"], "prompt": prompt, "provider": "gemini"}
            logger.warning("generate_image: Gemini returned no image, falling back to Hugging Face")
        except Exception as exc:
            logger.warning("generate_image: Gemini failed (%s), falling back to Hugging Face", exc)
    else:
        logger.info("generate_image: GEMINI_API_KEY not set, using Hugging Face")

    hf = _generate_image_huggingface(prompt)
    if "error" not in hf:
        return hf
    logger.warning("generate_image: Hugging Face failed (%s), falling back to Cloudflare", hf["error"])
    cf = _generate_image_cloudflare(prompt)
    if "error" not in cf:
        return cf
    # Both failed: report both, so the user sees e.g. "out of credits" and
    # "not configured" rather than only the last one.
    return {"error": f"Hugging Face: {hf['error']} | Cloudflare: {cf['error']}"}


# Cloudflare Workers AI — third step of generate_image's cascade. Free daily
# allowance on a Cloudflare account; needs CLOUDFLARE_ACCOUNT_ID and an API
# token with the "Workers AI" permission (CLOUDFLARE_API_TOKEN). Skipped with
# an error result when either is unset.
_CF_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"


def _generate_image_cloudflare(prompt: str) -> dict:
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        return {"error": "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not configured."}

    import requests

    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{_CF_IMAGE_MODEL}"
    try:
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}"},
            json={"prompt": prompt, "steps": 4},
            timeout=60,
        )
        body = r.json()
    except Exception as exc:
        return {"error": str(exc)}

    image = (body.get("result") or {}).get("image") if isinstance(body, dict) else None
    if r.ok and image:
        # FLUX schnell on Workers AI returns a base64 JPEG.
        return {"image_url": f"data:image/jpeg;base64,{image}", "prompt": prompt, "provider": "cloudflare"}
    errors = body.get("errors") if isinstance(body, dict) else None
    message = (errors[0].get("message") if errors and isinstance(errors[0], dict) else None)
    return {"error": message or f"Cloudflare returned status {r.status_code}"}


class _AttrDict(dict):
    """dict that also supports attribute access (inputs.topic as well as
    inputs['topic']). Generated tool implementations inconsistently use both
    styles for the injected inputs dict despite the bootstrap prompt showing
    bracket notation — this makes both work instead of the attribute form
    crashing with AttributeError: 'dict' object has no attribute '...'."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self[name] = value


def execute_tool(implementation: str, inputs: dict) -> object:
    """Execute a Claude-generated tool implementation in a restricted namespace.

    The implementation string must assign its result to `result`.
    inputs are injected both as the `inputs` dict AND as top-level names,
    so generated code can use either inputs['query'] or just query directly.
    """
    import requests
    import json
    import os
    import re
    import math
    import datetime
    import collections
    import urllib.parse
    import tempfile

    inputs = _AttrDict(inputs)

    namespace = {
        "__builtins__": _SAFE_BUILTINS,
        "inputs": inputs,
        "input_data": inputs,   # alias — Claude sometimes generates this name
        "input": inputs,        # alias — Claude sometimes generates this name too (singular, not the builtin)
        **inputs,               # bare names: query, location, filename, etc.
        "requests": _TimeoutRequests(requests, DEFAULT_TOOL_HTTP_TIMEOUT_SECONDS),
        "json": json,
        "os": os,
        "re": re,
        "math": math,
        "datetime": datetime,
        "collections": collections,
        "urllib": urllib,
        "TEMP_DIR": tempfile.gettempdir(),  # platform-correct temp dir
        # Generated implementations sometimes assume these primitives are
        # callable Python functions (bootstrap tells the model they're
        # "always available to the agent", which is true at the tool-call
        # level but not automatically true inside this exec() sandbox) —
        # expose the real functions so that code doesn't crash with a
        # NameError when it does this.
        "search_jobs": search_jobs,
        "fetch_page": fetch_page,
        "result": None,
    }

    try:
        exec(compile(implementation, "<tool>", "exec"), namespace)
        return namespace.get("result", "No result returned.")
    except Exception:
        return f"Tool execution error:\n{traceback.format_exc()}"
