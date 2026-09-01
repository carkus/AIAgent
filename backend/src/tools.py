import traceback
import builtins


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


def search_jobs(what: str, where: str = "", country: str = "au",
                 results_per_page: int = 20, page: int = 1) -> dict:
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

    namespace = {
        "__builtins__": _SAFE_BUILTINS,
        "inputs": inputs,
        "input_data": inputs,   # alias — Claude sometimes generates this name
        **inputs,               # bare names: query, location, filename, etc.
        "requests": requests,
        "json": json,
        "os": os,
        "re": re,
        "math": math,
        "datetime": datetime,
        "collections": collections,
        "urllib": urllib,
        "TEMP_DIR": tempfile.gettempdir(),  # platform-correct temp dir
        "result": None,
    }

    try:
        exec(compile(implementation, "<tool>", "exec"), namespace)
        return namespace.get("result", "No result returned.")
    except Exception:
        return f"Tool execution error:\n{traceback.format_exc()}"
