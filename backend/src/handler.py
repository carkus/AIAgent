import json
from bootstrap import generate_agent_config
from agent import run_agent


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
    if event.get("httpMethod") == "OPTIONS":
        return _cors_response(200, {})

    try:
        body = json.loads(event.get("body", "{}"))
        messages = body.get("messages", [])
        agent_config = body.get("agent_config", {})

        if not messages or not agent_config:
            return _cors_response(400, {"error": "messages and agent_config are required"})

        result = run_agent(messages, agent_config)
        return _cors_response(200, result)
    except Exception as e:
        return _cors_response(500, {"error": str(e)})
