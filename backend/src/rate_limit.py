"""
Simple in-process per-IP rate limiter for the production deployment.

Purpose: bound worst-case Gemini API spend from anonymous public traffic on
/bootstrap and /agent (the two routes that call an LLM). This is NOT a
privacy/access-control layer — see DEPLOY.md for that (Cloudflare Access).
A rate limiter still matters even behind Access, as insurance against a
leaked/shared link or a misconfigured Access policy.

Threading model: state lives in a process-local dict guarded by a lock.
This is only correct if gunicorn runs a SINGLE worker PROCESS (any number
of threads is fine and expected — see the gunicorn command in DEPLOY.md).
Running multiple worker processes gives each its own counters, silently
multiplying the effective limit.

Env vars:
  RATE_LIMIT_PER_MINUTE - burst cap per client IP (default 5)
  RATE_LIMIT_PER_DAY    - sustained cap per client IP (default 50)
"""
import os
import threading
import time
from collections import defaultdict, deque

_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "5"))
_PER_DAY = int(os.environ.get("RATE_LIMIT_PER_DAY", "50"))

_lock = threading.Lock()
_minute_hits: dict[str, deque] = defaultdict(deque)
_day_hits: dict[str, deque] = defaultdict(deque)


def check(client_id: str) -> str | None:
    """
    Records one hit for `client_id` and returns None if it's within both
    limits, or an error message (safe to return to the caller) if not.
    """
    now = time.time()
    with _lock:
        minute_bucket = _minute_hits[client_id]
        while minute_bucket and now - minute_bucket[0] > 60:
            minute_bucket.popleft()

        day_bucket = _day_hits[client_id]
        while day_bucket and now - day_bucket[0] > 86400:
            day_bucket.popleft()

        if len(minute_bucket) >= _PER_MINUTE:
            return f"Rate limit exceeded: max {_PER_MINUTE} requests/minute per client. Try again shortly."
        if len(day_bucket) >= _PER_DAY:
            return f"Daily limit exceeded: max {_PER_DAY} requests/day per client."

        minute_bucket.append(now)
        day_bucket.append(now)
        return None


def client_ip(request) -> str:
    """
    Best-effort real client IP behind Cloudflare. Cloudflare sets
    CF-Connecting-IP on every proxied request (Tunnel included); trust that
    over X-Forwarded-For (which a direct caller could forge) when present.
    """
    return (
        request.headers.get("CF-Connecting-IP")
        or request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        or request.remote_addr
        or "unknown"
    )
