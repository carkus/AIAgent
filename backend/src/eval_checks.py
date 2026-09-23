"""
Self-evaluation checks (root CLAUDE.md eval-framework task): the user asked
for the AI to test its own output at every stage of a session — agent
generation at bootstrap time, chat responses, tool-call sequences, and
worker delegation results — not just one of these. One function per stage
below, each returning a list of uniform result dicts so the frontend
("feedback status bar") and eval_log.py need only one shape:

{
    "check": str,             # stable id, e.g. "tool_syntax"
    "target": "bootstrap" | "chat_response" | "tool_call" | "worker_delegation",
    "target_id": str | None,  # call_index for tool_call, worker persona name for worker_delegation/bootstrap
    "passed": bool,
    "reason": str,
    "method": "deterministic" | "llm_judge",
    "severity": "info" | "warning",
}

Deterministic checks are cheap, structural, and never call an LLM. An
llm_judge check for a given stage only runs once that stage's own
deterministic checks already passed — a config/response/worker result
already known to be broken doesn't need a second opinion, which bounds
judge-call volume without skipping genuinely ambiguous cases. Judge calls
reuse llm_client.create_chat_completion (the agent's own provider/model),
not a separate hardcoded "judge-tier" model.

Every public function here is best-effort: a judge call that returns
unparseable output is retried once with an explicit correction prompt (same
shape as bootstrap.py's _tool_syntax_errors retry); if still broken, or the
call itself raises, the judge check is simply omitted rather than faking a
result. Callers are expected to wrap each call to these functions in their
own try/except too, so an internal bug here never breaks the underlying
/bootstrap or /agent request.
"""
import json
import logging

from llm_client import create_chat_completion

logger = logging.getLogger(__name__)

_JUDGE_MAX_TOKENS = 300

_WORKER_FAILURE_PREFIXES = ("Worker failed:", "Worker crashed:", "Could not assemble a worker")

_SCHEMA_TYPE_MAP = {
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "object": dict,
    "array": list,
}


def _result(check, target, target_id, passed, reason, method, severity="info"):
    return {
        "check": check,
        "target": target,
        "target_id": target_id,
        "passed": passed,
        "reason": reason,
        "method": method,
        "severity": severity,
    }


def _judge(provider, model, rubric_prompt: str) -> tuple[bool, str] | None:
    """One LLM call asking for a strict-JSON {"passed": bool, "reason": str}
    verdict. Retries once with a correction message on unparseable output;
    returns None (never a fabricated result) if it's still broken or the
    call itself raises."""
    prompt = rubric_prompt + (
        '\n\nRespond with ONLY a JSON object of the exact shape '
        '{"passed": true|false, "reason": "<one sentence>"}. No markdown '
        "fences, no other text."
    )
    messages = [{"role": "user", "content": prompt}]
    for attempt in range(2):
        try:
            response = create_chat_completion(
                provider=provider, model=model, max_tokens=_JUDGE_MAX_TOKENS,
                messages=messages,
            )
            content = (response.choices[0].message.content or "").strip()
            if content.startswith("```"):
                content = content.strip("`")
                if content[:4].lower() == "json":
                    content = content[4:]
                content = content.strip()
            parsed = json.loads(content)
            if isinstance(parsed, dict) and isinstance(parsed.get("passed"), bool):
                return bool(parsed["passed"]), str(parsed.get("reason") or "")
        except Exception as e:
            logger.info("eval_checks._judge attempt %d failed: %s", attempt, e)
        if attempt == 0:
            messages.append({
                "role": "user",
                "content": (
                    'That was not valid JSON. Respond with ONLY '
                    '{"passed": true|false, "reason": "..."}, nothing else.'
                ),
            })
    return None


def check_bootstrap(
    config: dict, purpose: str, provider: str | None, model: str | None,
    dropped_tool_names: list[str] | None = None, target_id: str | None = None,
) -> list[dict]:
    results = []
    tools = [t for t in (config.get("tools") or []) if isinstance(t, dict)]
    dropped = dropped_tool_names or []

    broken = []
    for t in tools:
        impl = t.get("implementation")
        if not impl:
            continue
        try:
            compile(impl, "<tool>", "exec")
        except SyntaxError:
            broken.append(t.get("name", "?"))
    tool_syntax_passed = not broken and not dropped
    reason_parts = []
    if dropped:
        reason_parts.append(f"dropped after a failed correction retry: {', '.join(dropped)}")
    if broken:
        reason_parts.append(f"still fails to compile: {', '.join(broken)}")
    reason = "; ".join(reason_parts) if reason_parts else f"all {len(tools)} tool implementation(s) compile cleanly"
    results.append(_result(
        "tool_syntax", "bootstrap", target_id, tool_syntax_passed, reason,
        "deterministic", severity="info" if tool_syntax_passed else "warning",
    ))

    names = {t.get("name") for t in tools}
    has_save_output = "save_output" in names
    results.append(_result(
        "required_tool_present", "bootstrap", target_id, has_save_output,
        "save_output tool is present" if has_save_output else "save_output tool is missing from the generated config",
        "deterministic", severity="info" if has_save_output else "warning",
    ))

    shape_issues = []
    for t in tools:
        name = t.get("name", "?")
        if t.get("source") == "mcp":
            if not t.get("mcp_server") or not t.get("mcp_tool"):
                shape_issues.append(f"{name} (missing mcp_server/mcp_tool)")
        else:
            if not t.get("input_schema") or not t.get("implementation"):
                shape_issues.append(f"{name} (missing input_schema/implementation)")
    shape_passed = not shape_issues
    results.append(_result(
        "tool_schema_shape", "bootstrap", target_id, shape_passed,
        "every tool has the required keys for its kind" if shape_passed
        else f"malformed tool entries: {', '.join(shape_issues)}",
        "deterministic", severity="info" if shape_passed else "warning",
    ))

    if tools and has_save_output and tool_syntax_passed and shape_passed:
        tool_summary = "; ".join(
            f"{t.get('name')}: {t.get('description') or '(mcp tool)'}" for t in tools
        )
        verdict = _judge(
            provider, model,
            "An AI agent was configured for this purpose:\n"
            f"{purpose}\n\nIt was given these tools:\n{tool_summary}\n\n"
            "Do these tools plausibly serve the stated purpose? Answer false only "
            "if the toolset is clearly mismatched or missing something obviously "
            "essential to the purpose.",
        )
        if verdict is not None:
            passed, reason = verdict
            results.append(_result(
                "purpose_fit_judge", "bootstrap", target_id, passed, reason,
                "llm_judge", severity="info" if passed else "warning",
            ))

    return results


def check_chat_response(
    user_message: str, final_text: str, tool_calls_log: list[dict],
    stripped_link_count: int, provider: str | None, model: str | None,
) -> list[dict]:
    results = []
    non_empty = bool(final_text and final_text.strip())
    results.append(_result(
        "non_empty_response", "chat_response", None, non_empty,
        "response is non-empty" if non_empty else "response text was empty",
        "deterministic", severity="info" if non_empty else "warning",
    ))

    links_ok = stripped_link_count == 0
    results.append(_result(
        "unverified_links_stripped", "chat_response", None, links_ok,
        "no unverified links were found in the reply" if links_ok
        else f"{stripped_link_count} unverified link(s) were demoted to plain text before showing the reply",
        "deterministic", severity="info" if links_ok else "warning",
    ))

    if non_empty:
        tool_names = ", ".join(sorted({tc.get("tool", "?") for tc in tool_calls_log})) or "none"
        verdict = _judge(
            provider, model,
            f"A user asked:\n{user_message}\n\nTools called this turn: {tool_names}\n\n"
            f"The agent replied:\n{final_text[:2000]}\n\n"
            "Does this reply substantively address what the user asked?",
        )
        if verdict is not None:
            passed, reason = verdict
            results.append(_result(
                "response_relevance_judge", "chat_response", None, passed, reason,
                "llm_judge", severity="info" if passed else "warning",
            ))
    return results


def _schema_violations(inputs: dict, schema: dict) -> list[str]:
    issues = []
    if not isinstance(schema, dict):
        return issues
    props = schema.get("properties") or {}
    for field in schema.get("required") or []:
        if field not in inputs:
            issues.append(f"missing required field '{field}'")
    for field, value in inputs.items():
        spec = props.get(field)
        if not isinstance(spec, dict):
            continue
        expected = _SCHEMA_TYPE_MAP.get(spec.get("type"))
        if expected and value is not None and not isinstance(value, expected):
            issues.append(f"field '{field}' expected {spec.get('type')}, got {type(value).__name__}")
    return issues


def check_tool_call(
    tool_name: str, tool_inputs: dict, tool_def: dict | None, result_str: str,
    source: str, call_index: int,
) -> list[dict]:
    results = []
    schema = (tool_def or {}).get("input_schema")
    if schema:
        issues = _schema_violations(tool_inputs or {}, schema)
        passed = not issues
        results.append(_result(
            "tool_input_schema", "tool_call", str(call_index), passed,
            "inputs match the tool's declared schema" if passed else "; ".join(issues),
            "deterministic", severity="info" if passed else "warning",
        ))

    errored = isinstance(result_str, str) and result_str.startswith("Tool execution error:")
    results.append(_result(
        "tool_execution_error", "tool_call", str(call_index), not errored,
        f"{tool_name} executed without error" if not errored else f"{tool_name} raised an exception during execution",
        "deterministic", severity="info" if not errored else "warning",
    ))
    return results


def check_worker_delegation(
    task: str, final_response: str, tool_calls: list[dict], provider: str | None,
    model: str | None, worker_name: str | None = None,
) -> list[dict]:
    results = []
    failed = any((final_response or "").startswith(p) for p in _WORKER_FAILURE_PREFIXES)
    results.append(_result(
        "worker_completed", "worker_delegation", worker_name, not failed,
        "worker returned a final response" if not failed else final_response,
        "deterministic", severity="info" if not failed else "warning",
    ))

    if tool_calls:
        errors = [
            tc for tc in tool_calls
            if isinstance(tc.get("result"), str) and tc["result"].startswith("Tool execution error:")
        ]
        ok = not errors
        results.append(_result(
            "worker_tool_errors", "worker_delegation", worker_name, ok,
            "none of the worker's tool calls errored" if ok
            else f"{len(errors)} of {len(tool_calls)} of the worker's tool call(s) errored",
            "deterministic", severity="info" if ok else "warning",
        ))

    if not failed:
        verdict = _judge(
            provider, model,
            f"A worker agent was delegated this task:\n{task}\n\n"
            f"It responded:\n{(final_response or '')[:2000]}\n\n"
            "Did the worker's response actually accomplish the delegated task?",
        )
        if verdict is not None:
            passed, reason = verdict
            results.append(_result(
                "worker_task_fit_judge", "worker_delegation", worker_name, passed, reason,
                "llm_judge", severity="info" if passed else "warning",
            ))
    return results
