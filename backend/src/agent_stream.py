import concurrent.futures
import json
import time
from llm_client import create_chat_completion
from tools import execute_tool, fetch_page, search_jobs
import mcp_client

_PRIMITIVE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_jobs",
            "description": (
                "Search live job listings via the Adzuna Job Search API — a real API, not "
                "scraping. Use this for ANY job search, salary research, or job-market task. "
                "Prefer this over fetch_page against SEEK/Indeed/LinkedIn: those block "
                "datacenter traffic with a 403 regardless of headers, this doesn't."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "description": "Job title or keywords, e.g. 'software engineer'"},
                    "where": {"type": "string", "description": "Location, e.g. 'Melbourne'. Optional — omit for nationwide."},
                    "country": {"type": "string", "description": "Two-letter Adzuna country code, default 'au'."},
                    "results_per_page": {"type": "integer", "description": "Max 50, default 20."},
                    "page": {"type": "integer", "description": "Page number for pagination, default 1."},
                },
                "required": ["what"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": (
                "Fetch any public web page and return its clean text content (HTML, scripts, "
                "and SVG stripped). Use this for company pages, news, or any general URL. "
                "For job listings/salary data, use search_jobs instead — job boards block "
                "scraping from this server's IP."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL to fetch"}
                },
                "required": ["url"],
            },
        },
    }
]

_SEARCH_TOOL_NAMES = {
    "web_search", "search_web", "google_search", "bing_search",
    "search", "search_internet", "internet_search",
}

# Multi-agent orchestration, first scaffold (CLAUDE.md roadmap item 1).
# Available to the main agent only — passing allow_delegation=False (used when
# orchestrator.run_worker runs a worker's own loop) omits this tool entirely,
# so a worker never sees it and can't spawn further sub-workers. One level deep
# for now.
_DELEGATE_TOOL = {
    "type": "function",
    "function": {
        "name": "delegate_to_worker",
        "description": (
            "Spin up a fresh worker agent — with its own name, personality, and "
            "purpose-built toolset — to independently handle ONE focused, "
            "self-contained subtask, then hand its finished result back to you. "
            "Use this to split a genuinely separable request into parts a "
            "specialist can each own, rather than doing everything yourself with "
            "one toolset. The worker does not see this conversation — give it "
            "everything it needs via `task` and `context`."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "A complete, self-contained description of the subtask for the worker to accomplish.",
                },
                "context": {
                    "type": "string",
                    "description": "Optional extra background or data (e.g. results from your own earlier tool calls) the worker needs but `task` alone doesn't convey.",
                },
            },
            "required": ["task"],
        },
    },
}

MAX_DELEGATIONS_PER_REQUEST = 6


def run_agent_stream(messages: list, agent_config: dict, allow_delegation: bool = True):
    """
    Generator that yields event dicts as the agent loop runs.

    Event shapes:
      {"type": "tool_start",  "tool": "name", "inputs": {...}}
      {"type": "tool_result", "tool": "name", "result": "..."}
      {"type": "done",        "response": "...", "tool_calls": [...], "duration_seconds": N}
      {"type": "error",       "message": "..."}

    allow_delegation gates the delegate_to_worker primitive (see _DELEGATE_TOOL
    above) — False when this call itself IS a worker's loop, to keep
    orchestration one level deep.
    """
    system_prompt = agent_config["system_prompt"] + """

---
CRITICAL TOOL RULES — READ BEFORE CALLING ANY TOOL:

1. DO NOT call `web_search` or any generic search tool. There is no search engine connected. Every call returns 0 results and wastes a turn.

2. For job search, salary research, or job-market questions, USE `search_jobs` — it calls a real
   job search API and returns structured listings (title, company, location, salary, apply URL).
   Do NOT use `fetch_page` against SEEK/Indeed/LinkedIn or similar job boards — they block this
   server's IP with a 403 regardless of headers, so it will not work.

3. USE `fetch_page` for everything else — company pages, news, general URLs.

4. MANDATORY OUTPUT: When all fetches are done, write the actual findings — listing counts, job titles, salary ranges, company names. Do not say "search complete" or list tool names. The user cannot see tool output; your reply IS the report.

5. PREFER A DIAGRAM OVER A WORDY PARAGRAPH. When findings involve a comparison, a
   distribution, a breakdown by category, or a multi-step flow (e.g. salary ranges
   across roles, seniority/skill mix, counts by location or company, a process with
   stages), draw a Mermaid diagram in a ```mermaid fenced code block instead of
   restating the numbers in prose — use `pie` or `xychart-beta` for distributions/
   comparisons, `flowchart`/`graph` for a process or relationship, `mindmap` for a
   grouped breakdown of topics. Follow the diagram with at most one or two short
   sentences of takeaway — not a paragraph re-explaining what the diagram already
   shows. For a single flat fact (one number, one listing), just say it plainly;
   don't force a diagram where there's nothing to compare.
""" + (f"""
6. You also have `delegate_to_worker`. First, identify the distinct tasks the
   request actually requires. When it names multiple distinct keywords,
   topics, roles, or subjects to search/research (e.g. a request listing
   several comma-separated items — "python developer, react developer",
   "renewable energy, EV batteries, grid storage"), you MUST delegate ONE
   worker per keyword/topic, each with a `task` scoped to that single item —
   never research more than one keyword/topic yourself with your own tools
   when the request names several. Call every `delegate_to_worker` you need
   before writing your own findings. For a single keyword, or a request with
   no genuinely separable parts, handle it yourself instead — delegating a
   one-part task just adds latency for no benefit. Limit:
   {MAX_DELEGATIONS_PER_REQUEST} per turn — if there are more keywords than
   that, handle the remainder yourself with your own tools after delegating
   as many as the limit allows.
7. Once your workers report back, do NOT restate or re-summarize each one's
   full findings in your own reply — the user already sees each worker's
   complete response individually, attributed to that worker, in the UI.
   Your own reply should be short: at most a few sentences comparing or
   synthesizing across workers (or noting anything none of them covered),
   never a repeat of content they already reported.
---""" if allow_delegation else "\n---")

    tool_definitions = agent_config["tools"]

    tools = _PRIMITIVE_TOOLS + ([_DELEGATE_TOOL] if allow_delegation else []) + [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in tool_definitions
    ]

    # Keyed by name -> the full tool def, not just `implementation`, so
    # dispatch below can tell a generated tool from an MCP-backed one
    # (CLAUDE.md MCP priority 6) and route accordingly.
    tool_def_map = {t["name"]: t for t in tool_definitions}
    provider = agent_config.get("provider")
    model = agent_config.get("ollama_model")

    # Build initial message list: system prompt first, then conversation history
    current_messages: list[dict] = [{"role": "system", "content": system_prompt}]
    for m in messages:
        current_messages.append({"role": m["role"], "content": m["content"]})

    tool_calls_log = []
    started_at = time.time()
    total_input_tokens = 0
    total_output_tokens = 0
    nudged = False
    delegation_count = 0
    # Hard ceiling on LLM calls per request — without this, a model stuck in a
    # tool-calling loop (or a buggy tool) burns unlimited API quota on one request.
    max_iterations = 25

    try:
        for _ in range(max_iterations):
            response = create_chat_completion(
                provider=provider,
                model=model,
                max_tokens=16000,
                tools=tools,
                messages=current_messages,
            )

            choice = response.choices[0]
            message = choice.message
            finish_reason = choice.finish_reason

            if response.usage:
                total_input_tokens += response.usage.prompt_tokens
                total_output_tokens += response.usage.completion_tokens

            # Append assistant turn to history. Dump the full raw message rather
            # than hand-picking fields (id/type/function) — Gemini's "thinking"
            # models attach a thought_signature to each function-call part and
            # require it echoed back verbatim on the next turn, or the next call
            # 400s with "Function call is missing a thought_signature"
            # (https://ai.google.dev/gemini-api/docs/thinking#signatures). The
            # openai SDK's models are extra="allow", so model_dump() preserves
            # whatever provider-specific extras came back instead of silently
            # dropping them.
            assistant_msg = message.model_dump(exclude_none=True)
            assistant_msg["role"] = "assistant"
            assistant_msg["content"] = assistant_msg.get("content") or ""
            current_messages.append(assistant_msg)

            # No tool calls → final response
            if not message.tool_calls:
                final_text = message.content or ""
                if (
                    not nudged
                    and tool_calls_log
                    and finish_reason == "stop"
                    and len(final_text.strip()) < 400
                ):
                    nudged = True
                    current_messages.append({
                        "role": "user",
                        "content": (
                            "Present your complete findings now in full detail. "
                            "Show the actual data, results, and analysis from your searches."
                        ),
                    })
                    continue

                yield {
                    "type": "done",
                    "response": final_text,
                    "tool_calls": tool_calls_log,
                    "duration_seconds": round(time.time() - started_at, 1),
                    "usage": {
                        "input_tokens": total_input_tokens,
                        "output_tokens": total_output_tokens,
                    },
                    "rate_limits": {
                        "tokens_limit": None,
                        "tokens_remaining": None,
                        "tokens_reset": None,
                        "requests_limit": None,
                        "requests_remaining": None,
                    },
                }
                return

            # Execute each tool call and collect results. delegate_to_worker
            # calls are independent of each other (separate bootstrapped
            # workers, no shared state) and are dispatched to a thread pool
            # instead of run one at a time — each is a blocking bootstrap +
            # agent-loop round trip over the network, so N of them used to
            # cost N times as long as the slowest one. Every other tool call
            # still runs synchronously in submission order, unchanged.
            tool_result_messages = []
            pending_workers: dict[int, tuple] = {}  # idx -> (future, tc, tool_name, tool_inputs, source)
            executor = None

            def _finish(tc, tool_name, tool_inputs, result, source):
                try:
                    result_str = json.dumps(result, default=str)
                except Exception:
                    result_str = str(result)
                tool_calls_log.append({
                    "tool": tool_name,
                    "inputs": tool_inputs,
                    "result": result_str,
                    "source": source,
                })
                tool_result_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_str,
                })
                return result_str

            for idx, tc in enumerate(message.tool_calls):
                tool_name = tc.function.name
                try:
                    tool_inputs = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    tool_inputs = {}

                tool_def = tool_def_map.get(tool_name)
                source = "mcp" if tool_def and tool_def.get("source") == "mcp" else (
                    "primitive" if tool_name in ("fetch_page", "search_jobs", "delegate_to_worker") else "generated"
                )
                yield {"type": "tool_start", "tool": tool_name, "inputs": tool_inputs, "source": source, "call_index": idx}

                if tool_name == "delegate_to_worker":
                    if delegation_count >= MAX_DELEGATIONS_PER_REQUEST:
                        result = {
                            "error": (
                                f"Delegation limit ({MAX_DELEGATIONS_PER_REQUEST}) reached "
                                "for this turn — finish the task yourself with the tools "
                                "you already have."
                            )
                        }
                        result_str = _finish(tc, tool_name, tool_inputs, result, source)
                        yield {"type": "tool_result", "tool": tool_name, "result": result_str, "source": source, "call_index": idx}
                    else:
                        delegation_count += 1
                        # Deferred import: orchestrator imports run_agent_stream from
                        # this module, so importing it back at module load time would
                        # be circular. Safe here since it's only needed once this
                        # branch actually runs.
                        from orchestrator import run_worker
                        if executor is None:
                            executor = concurrent.futures.ThreadPoolExecutor(
                                max_workers=MAX_DELEGATIONS_PER_REQUEST
                            )
                        future = executor.submit(
                            run_worker,
                            task=tool_inputs.get("task", ""),
                            context=tool_inputs.get("context", ""),
                            provider=provider,
                            model=model,
                        )
                        pending_workers[idx] = (future, tc, tool_name, tool_inputs, source)
                    continue

                if tool_name == "fetch_page":
                    result = fetch_page(tool_inputs.get("url", ""))
                elif tool_name == "search_jobs":
                    result = search_jobs(
                        what=tool_inputs.get("what", ""),
                        where=tool_inputs.get("where", ""),
                        country=tool_inputs.get("country") or "au",
                        results_per_page=tool_inputs.get("results_per_page") or 20,
                        page=tool_inputs.get("page") or 1,
                    )
                elif tool_name in _SEARCH_TOOL_NAMES:
                    result = {
                        "error": (
                            "No generic search engine is connected. Do NOT call this tool again. "
                            "For job listings/salary data, call search_jobs instead. "
                            "For any other URL, use fetch_page."
                        )
                    }
                elif source == "mcp":
                    # Routed to the real vetted MCP server, not exec()'d —
                    # this is the whole point of CLAUDE.md's MCP priority 6:
                    # bootstrap picked the tool, never wrote its implementation.
                    result = mcp_client.call_tool(tool_def["mcp_server"], tool_def["mcp_tool"], tool_inputs)
                else:
                    implementation = tool_def["implementation"] if tool_def else "result = 'Unknown tool'"
                    result = execute_tool(implementation, tool_inputs)

                result_str = _finish(tc, tool_name, tool_inputs, result, source)
                yield {"type": "tool_result", "tool": tool_name, "result": result_str, "source": source, "call_index": idx}

            # Stream each delegated worker's result as soon as it finishes —
            # not in submission order — since running them concurrently only
            # helps the UI if a fast worker's card doesn't wait behind a slow
            # one.
            if pending_workers:
                future_to_idx = {info[0]: idx for idx, info in pending_workers.items()}
                for future in concurrent.futures.as_completed(future_to_idx):
                    idx = future_to_idx[future]
                    _, tc, tool_name, tool_inputs, source = pending_workers[idx]
                    try:
                        result = future.result()
                    except Exception as e:
                        result = {"error": f"Worker crashed: {e}"}
                    result_str = _finish(tc, tool_name, tool_inputs, result, source)
                    yield {"type": "tool_result", "tool": tool_name, "result": result_str, "source": source, "call_index": idx}
                executor.shutdown(wait=False)

            current_messages.extend(tool_result_messages)

        yield {"type": "error", "message": f"Stopped after {max_iterations} tool-call rounds without a final answer."}

    except Exception as e:
        yield {"type": "error", "message": str(e)}
