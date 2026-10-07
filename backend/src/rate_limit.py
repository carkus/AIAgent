"""
Simple per-IP rate limiter for the production deployment.

Purpose: bound worst-case Gemini API spend from anonymous public traffic on
/bootstrap and /agent (the two routes that call an LLM). This is NOT a
privacy/access-control layer — see DEPLOY.md for that (Cloudflare Access).
A rate limiter still matters even behind Access, as insurance against a
leaked/shared link or a misconfigured Access policy.

Hits are stored in the shared SQLite database (db.py, table rate_limit_hits)
rather than a process-local dict, so the limit holds across any number of
gunicorn worker processes — process-local counters used to be the reason
production had to run a single worker (each worker would have kept its own
counts, silently multiplying the effective limit). Counts also survive a
restart now. The check-and-record runs inside one write transaction, so two
simultaneous requests from the same client can't both squeeze under the cap.

Env vars:
  RATE_LIMIT_PER_MINUTE - burst cap per client IP (default 5)
  RATE_LIMIT_PER_DAY    - sustained cap per client IP (default 50)
"""
import os
import time

import db

_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "5"))
_PER_DAY = int(os.environ.get("RATE_LIMIT_PER_DAY", "50"))


def check(client_id: str) -> str | None:
    """
    Records one hit for `client_id` and returns None if it's within both
    limits, or an error message (safe to return to the caller) if not.
    """
    now = time.time()
    with db.write() as conn:
        conn.execute("DELETE FROM rate_limit_hits WHERE ts < ?", (now - 86400,))
        minute_count, day_count = conn.execute(
            "SELECT SUM(ts >= ?), COUNT(*) FROM rate_limit_hits WHERE client_id = ?",
            (now - 60, client_id),
        ).fetchone()

        if (minute_count or 0) >= _PER_MINUTE:
            return f"Rate limit exceeded: max {_PER_MINUTE} requests/minute per client. Try again shortly."
        if day_count >= _PER_DAY:
            return f"Daily limit exceeded: max {_PER_DAY} requests/day per client."

        conn.execute("INSERT INTO rate_limit_hits (client_id, ts) VALUES (?, ?)", (client_id, now))
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
