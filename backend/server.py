"""
Local development server with streaming support.
Replaces `sam local start-api` for the agent endpoint.

Usage:
    pip install flask anthropic requests
    python backend/server.py

Reads credentials from env.json in the project root (same file used by SAM local).
Listens on http://localhost:3000
"""

import json
import os
import sys

# Load env vars from env.json (SAM format) so we reuse the same credentials file
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ENV_JSON = os.path.join(_ROOT, "env.json")
if os.path.exists(_ENV_JSON):
    with open(_ENV_JSON) as f:
        _sections = json.load(f)
    for _section in _sections.values():
        for k, v in _section.items():
            os.environ.setdefault(k, v)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from flask import Flask, Response, jsonify, request, stream_with_context
from bootstrap import generate_agent_config
from agent_stream import run_agent_stream

app = Flask(__name__)


@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return response


@app.route("/bootstrap", methods=["POST", "OPTIONS"])
def bootstrap():
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json()
    purpose = (body or {}).get("purpose", "").strip()
    if not purpose:
        return jsonify({"error": "purpose is required"}), 400
    try:
        config = generate_agent_config(purpose)
        return jsonify(config)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/agent", methods=["POST", "OPTIONS"])
def agent():
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json()
    messages = (body or {}).get("messages", [])
    agent_config = (body or {}).get("agent_config", {})

    def generate():
        try:
            for event in run_agent_stream(messages, agent_config):
                yield json.dumps(event) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={"X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    print(f"Starting local dev server on http://localhost:{port}")
    app.run(port=port, debug=False, threaded=True)
