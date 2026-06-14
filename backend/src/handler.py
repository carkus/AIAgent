import json
from bootstrap import generate_agent_config
from agent import run_agent
from agent_stream import run_agent_stream


def _cors_response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
        "body": json.dumps(body),
    }


def bootstrap_handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return _cors_response(200, {})

    try:
        body = json.loads(event.get("body", "{}"))
        purpose = body.get("purpose", "").strip()
        if not purpose:
            return _cors_response(400, {"error": "purpose is required"})

        config = generate_agent_config(purpose)
        return _cors_response(200, config)
    except Exception as e:
        return _cors_response(500, {"error": str(e)})


def agent_handler(event, context):
    """
    Streaming handler — requires a Lambda Function URL with InvokeMode: RESPONSE_STREAM.
    Emits NDJSON events (one JSON object per line) as the agent loop runs.
    """
    try:
        body = json.loads(event.get("body", "{}"))
        messages = body.get("messages", [])
        agent_config = body.get("agent_config", {})

        if not messages or not agent_config:
            yield json.dumps({"type": "error", "message": "messages and agent_config are required"})
            return

        for evt in run_agent_stream(messages, agent_config):
            yield json.dumps(evt) + "\n"

    except Exception as e:
        yield json.dumps({"type": "error", "message": str(e)}) + "\n"
