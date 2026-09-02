"""
Local development server with streaming support.
Replaces `sam local start-api` for the agent endpoint.

Usage:
    pip install flask openai requests
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

# Saved-search storage lives outside backend/ deliberately — deploy/redeploy.sh's
# deploy_backend() tars and overwrites the entire backend/ directory on every
# deploy, which would silently clobber accumulated data if it lived in there.
os.environ.setdefault("DATA_DIR", os.path.join(_ROOT, "data"))

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import tempfile
from flask import Flask, Response, jsonify, request, stream_with_context
from bootstrap import generate_agent_config_stream
from agent_stream import run_agent_stream
from llm_client import list_ollama_models
import rate_limit
import saved_searches

app = Flask(__name__)


@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


@app.route("/bootstrap", methods=["POST", "OPTIONS"])
def bootstrap():
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json()
    purpose = (body or {}).get("purpose", "").strip()
    if not purpose:
        return jsonify({"error": "purpose is required"}), 400
    provider = ((body or {}).get("provider") or "").strip() or None
    model = ((body or {}).get("ollama_model") or "").strip() or None
    # Only rate-limit requests that actually spend Gemini quota — a local-only
    # request costs nothing, so don't burn a caller's rate-limit budget on it.
    if provider != "ollama":
        rate_limit_error = rate_limit.check(rate_limit.client_ip(request))
        if rate_limit_error:
            return jsonify({"error": rate_limit_error}), 429
    def generate():
        try:
            for event in generate_agent_config_stream(purpose, provider, model):
                yield json.dumps(event) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={"X-Accel-Buffering": "no"},
    )


@app.route("/models", methods=["GET", "OPTIONS"])
def models():
    if request.method == "OPTIONS":
        return "", 204
    return jsonify({"models": list_ollama_models()})


@app.route("/file/<path:filename>", methods=["GET"])
def serve_file(filename):
    path = os.path.join(tempfile.gettempdir(), filename)
    if not os.path.exists(path):
        return jsonify({"error": "File not found"}), 404
    with open(path, encoding="utf-8", errors="replace") as f:
        content = f.read()
    return jsonify({"filename": filename, "content": content})


@app.route("/saved-searches", methods=["GET", "POST", "OPTIONS"])
def saved_searches_collection():
    if request.method == "OPTIONS":
        return "", 204
    if request.method == "GET":
        return jsonify({"searches": saved_searches.list_searches()})
    body = request.get_json() or {}
    name = (body.get("name") or "").strip()
    keywords = body.get("keywords") or []
    if not name or not isinstance(keywords, list):
        return jsonify({"error": "name and keywords are required"}), 400
    agent_type = body.get("agentType") or None
    entry = saved_searches.add_search(name, keywords, agent_type)
    return jsonify(entry), 201


@app.route("/saved-searches/<search_id>", methods=["DELETE", "OPTIONS"])
def saved_searches_item(search_id):
    if request.method == "OPTIONS":
        return "", 204
    saved_searches.delete_search(search_id)
    return "", 204


@app.route("/agent", methods=["POST", "OPTIONS"])
def agent():
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json()
    messages = (body or {}).get("messages", [])
    agent_config = (body or {}).get("agent_config", {})

    if agent_config.get("provider") != "ollama":
        rate_limit_error = rate_limit.check(rate_limit.client_ip(request))
        if rate_limit_error:
            return jsonify({"error": rate_limit_error}), 429

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
    port = int(os.environ.get("PORT", 4891))
    print(f"Starting local dev server on http://localhost:{port}")
    app.run(port=port, debug=False, threaded=True)
