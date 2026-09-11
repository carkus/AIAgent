# CLAUDE.md — AI Agent Project

## What This Project Is

A self-scaffolding AI agent platform. The user describes their goal in plain language; Claude generates the agent's system prompt, tool definitions, and Python tool implementations at runtime. The agent then runs as that purpose-built agent. No code changes are needed between different agent use cases.

Bootstrap is grounded two ways rather than inventing everything cold each
time (root `c:\_work\CLAUDE.md` priorities 5/6): retrieval of similar past
`purpose → generated config` pairs as few-shot examples (`bootstrap_memory.py`
+ `embeddings.py`), and a small directory of vetted MCP servers the model can
pick a real tool from instead of writing a Python implementation
(`mcp_registry.py` + `mcp_client.py`). Both apply equally to the main agent
and to worker agents spun up via `delegate_to_worker` (`orchestrator.py`),
since a worker is bootstrapped through the exact same call.

Two phases:
1. **Bootstrap** — `POST /bootstrap` → Claude generates `AgentConfig` (system prompt + tools), grounded by past-bootstrap few-shot retrieval and the vetted MCP tool catalog
2. **Agent loop** — `POST /agent` → Claude runs with those tools until `end_turn`; MCP-backed tools route to the real server, generated tools still run via `exec()`

The frontend is one consumer of a bootstrapped agent, not the only one: an
explicit **publish** step (`POST /agents`, "Publish as MCP tool" in `Chat.tsx`)
exposes a chosen agent as a callable MCP tool via `backend/mcp_server.py`, so
any MCP client — Claude Desktop, Claude Code, jobfit, another AIAgent
instance — can call it directly (see Backend Patterns' "AIAgent as an MCP
server"). This was the project's other stated main goal alongside the React
UI, not an add-on.

---

## Architecture

Production and local dev both run the **same Flask app** (`backend/server.py`),
streaming NDJSON to the browser — not the Lambda/API Gateway split this file
used to describe:

```
frontend (React/Vite)  →  nginx (droplet) / Vite proxy (dev)  →  Flask (server.py, gunicorn in prod)  →  Gemini ⟶ Ollama (dev-only fallback)
                                                                        │
                                                          ┌─────────────┼─────────────┐
                                                   exec() tool impls   MCP tool calls  bootstrap few-shot
                                                   written by Gemini   (mcp_client.py) grounding (bootstrap_memory.py)

any MCP client (Claude Desktop, Claude Code, jobfit, ...)  →  mcp_server.py (own uvicorn/ASGI process, port 8788 in prod)  →  agent_registry.py (published agents)  →  run_agent_stream()  →  Gemini ⟶ Ollama
```

A **second, structurally separate process** — `backend/mcp_server.py` — runs
alongside `server.py`, not as routes on it (the `mcp` SDK's HTTP transports
are Starlette/ASGI-only; Flask/gunicorn is WSGI). It reuses `run_agent_stream`
directly, the same execution path the Flask `/agent` route drives — see
Backend Patterns' "AIAgent as an MCP server".

An AWS SAM/Lambda path (`template.yaml`, `backend/src/handler.py`) still
exists in the repo but is **dev-only tooling now** (`sam local`), not what's
deployed — see [Deployment](#deployment) below. Don't extend `handler.py`
expecting it to reach production.

- **`server.py`** — Flask entry point for both `sam local`-replacement dev and the deployed gunicorn service; routes: `/bootstrap`, `/agent`, `/models`, `/file/<name>`
- **`bootstrap.py`** (`generate_agent_config_stream`) — streams bootstrap progress, ends with `AgentConfig` JSON
- **`agent_stream.py`** (`run_agent_stream`) — the agentic loop actually used in production (streams `tool_start`/`tool_result`/`done` events); `agent.py`'s non-streaming `run_agent` is dead code, unused by any deployed path
- **`llm_client.py`** — provider cascade: Gemini (cloud) → Ollama (local-only; only reachable from `sam local`/`server.py` dev, never a deployed instance)
- **Frontend** — three phases managed in `App.tsx`: `setup` → `bootstrapping` → `chat`

---

## Key Files

| File | Role |
|------|------|
| `backend/server.py` | Flask app — the actual runtime for dev and production (routes, CORS, rate-limit gate) |
| `backend/src/bootstrap.py` | Streams the bootstrap call to Gemini/Ollama; parses `AgentConfig`; grounds the prompt with few-shot examples (`bootstrap_memory`) and the vetted MCP tool catalog (`mcp_client`) |
| `backend/src/agent_stream.py` | The agentic loop that actually runs in production: create → tool_use → execute → repeat, streamed; routes `source: "mcp"` tool calls to `mcp_client` instead of `exec()` |
| `backend/src/orchestrator.py` | Multi-agent scaffold — `run_worker()` bootstraps and runs a delegated worker via the same `generate_agent_config`/`run_agent_stream` calls as the main agent, `is_worker=True` |
| `backend/src/llm_client.py` | Gemini → Ollama cascade (`create_chat_completion`), model listing for the Setup screen's picker |
| `backend/src/embeddings.py` | `embed_text()` — Gemini (`gemini-embedding-2-preview`) or Ollama (`nomic-embed-text`) embeddings + cosine similarity, used for bootstrap grounding |
| `backend/src/bootstrap_memory.py` | JSON-file store of past `purpose → generated config` pairs (`data/bootstrap_memory.json`); `record()`/`retrieve_similar()` power bootstrap few-shot grounding (RAG) |
| `backend/src/mcp_registry.py` | The vetted MCP server directory (currently `mcp-server-time`) — where a new trusted MCP server is added |
| `backend/src/mcp_client.py` | Sync wrapper around the official `mcp` SDK's stdio client — `catalog_summary()` lists real tool schemas, `call_tool()` executes one |
| `backend/src/agent_registry.py` | File-store of *published* agents (`data/agent_registry.json`) — the explicit, human-in-the-loop persistence step (partially addresses Limitation #7) that backs `mcp_server.py`'s tool list; `publish()`/`unpublish()`/`list_agents()`/`get_by_tool_name()` |
| `backend/mcp_server.py` | Runnable entrypoint (sibling of `server.py`, not in `src/`) exposing every published agent as an MCP tool over Streamable HTTP — its own ASGI process (`uvicorn`), since the `mcp` SDK's HTTP transports are Starlette-only and can't share Flask/gunicorn |
| `backend/src/rate_limit.py` | Per-IP rate limiting (process-local counters — see gunicorn `--workers 1` note in Deployment) |
| `backend/src/tools.py` | `execute_tool()` — runs Gemini-generated Python via `exec()`; also the primitive tools (`fetch_page`, `search_jobs`) |
| `backend/src/handler.py`, `backend/src/agent.py`, `template.yaml` | AWS SAM/Lambda path — dev-only (`sam local`), not deployed |
| `frontend/src/api.ts` | Typed `fetch` wrappers for `/bootstrap` and `/agent` |
| `frontend/src/types.ts` | Shared types: `AgentConfig`, `ToolDefinition`, `Message`, etc. |
| `frontend/src/App.tsx` | Phase state machine |
| `frontend/src/components/Setup.tsx` | Purpose input form |
| `frontend/src/components/Chat.tsx` | Chat UI; owns message history and calls `runAgent()` |
| `frontend/src/components/ToolActivity.tsx` | Renders tool call log inline under each assistant message |

---

## Model and API Defaults

- Provider cascade (`llm_client.py`): **Gemini** (`gemini-3.6-flash`) → **Ollama** (`qwen2.5` default, local-only). Production is Gemini-only — no Ollama on the droplet for this app (see Deployment).
- Per-agent `provider`/`ollama_model` choice made once on the Setup screen threads through both bootstrap and every agent-loop turn (`LlmProvider` in `types.ts`)
- Bootstrap call uses a single user message; agent loop maintains full message history
- Tool content blocks are passed back as `tool_result` in the next user turn

## Backend Patterns

### Adding a new primitive tool

Primitive tools are built-in capabilities available to all agents regardless of purpose. To add one:

1. Implement it in `tools.py` as a named function
2. Add it to the tool schemas list in `agent.py` alongside the dynamic tools
3. Add a handler branch in the tool execution section of `agent.py`

Currently, all tools are dynamic (generated by Claude). There are no hardcoded primitives yet — this is a planned addition (see limitations).

### Modifying the bootstrap prompt

The bootstrap prompt lives in `bootstrap.py` as `_BOOTSTRAP_PROMPT`, built by `_build_prompt()`. It now has three substitutions: `{purpose}`, `{fewshot}` (rendered by `_format_fewshot()` from `bootstrap_memory.retrieve_similar()` — empty string when there's no similar past bootstrap yet), and `{mcp_catalog}` (rendered by `_format_mcp_catalog()` from `mcp_client.catalog_summary()` — "(none currently available)" when no vetted MCP server is installed/reachable). The prompt instructs Claude to return a specific JSON schema, including the `source: "mcp"` shape for picking a vetted tool instead of writing one. If you change the schema, update `types.ts` to match.

After a config is generated, `_resolve_mcp_tools()` overwrites any `source: "mcp"` tool's name/description/input_schema from the real catalog (dropping it if the model named a server/tool that doesn't exist), and `bootstrap_memory.record()` embeds `purpose` and stores the config as a future few-shot example — both best-effort, never fail the bootstrap over either.

### Tool execution

`tools.py:execute_tool()` compiles and runs the implementation string with:
- `inputs` — dict of the tool's arguments as passed by Claude
- `requests` — the `requests` library
- `json`, `os` — standard library modules
- A restricted `__builtins__` allowlist (no `open`, no `__import__`, no `exec`/`eval`)

The implementation must assign its result to a variable named `result`.

A tool whose definition carries `source: "mcp"` skips this entirely — `agent_stream.py` routes it to `mcp_client.call_tool(mcp_server, mcp_tool, inputs)`, which calls the real vetted MCP server as a subprocess (`mcp_registry.py` lists which servers are trusted). No `implementation` string exists for these tools; there's nothing to `exec()`.

### Bootstrap grounding (RAG) and MCP tool selection

- `embeddings.py` — `embed_text(text, provider)` calls Gemini's OpenAI-compatible embeddings endpoint (`gemini-embedding-2-preview`) or, for `provider == "ollama"`, Ollama's native `/api/embed` (`nomic-embed-text`); returns `None` on any failure so callers degrade to "no grounding" rather than erroring.
- `bootstrap_memory.py` — file-backed store (`DATA_DIR/bootstrap_memory.json`, same lock/atomic-replace pattern as `saved_searches.py`) of past `{purpose, embedding, persona, tool_names, tool_descriptions, ...}` entries, capped at 200. `retrieve_similar()` does an in-memory cosine-similarity scan, filtered by `is_worker` so top-level user purposes and delegated worker subtasks (see below) aren't cross-matched.
- `mcp_registry.py` — the vetted MCP server directory; currently one entry (`mcp-server-time`, official Anthropic reference server, spawned via stdio). Add a new trusted server here, not by asking the model to shell out to one.
- `mcp_client.py` — sync wrapper (`asyncio.run`) around the official `mcp` SDK's `StdioServerParameters`/`stdio_client`/`ClientSession`. `catalog_summary()` fetches real tool schemas from every registered server (a server that fails to start is logged and simply omitted — bootstrap still works with zero vetted tools available); `call_tool()` runs one, returning `{"error": ...}` on failure instead of raising.
- Both features apply to worker bootstraps automatically — `orchestrator.run_worker()` calls `generate_agent_config(..., is_worker=True)`, the same function the main agent uses, just bucketed separately in `bootstrap_memory` so a narrow subtask doesn't get matched against a broad top-level purpose (or vice versa).

### AIAgent as an MCP server

Root `c:\_work\CLAUDE.md` Gaps item 4's reverse direction: AIAgent already
speaks MCP as a *client* (above); `backend/mcp_server.py` makes it an MCP
*server* too, exposing bootstrapped agents as tools any MCP client (Claude
Desktop, Claude Code, jobfit, another AIAgent instance) can call directly —
mirroring jobfit's own `/mcp` endpoint.

- **Publish is explicit, not automatic.** `POST /agents` (`server.py`) saves
  a chosen `AgentConfig` via `agent_registry.publish(name, description,
  agent_config)` — a small file-store (`data/agent_registry.json`, same
  lock/atomic-replace pattern as `saved_searches.py`) that is the slice of
  server-side `AgentConfig` persistence Limitation #7 previously lacked.
  Every generated tool still runs via `exec()` with only a builtins
  allowlist (Limitation #2), so turning a one-off bootstrap into a
  permanently externally-callable tool is a deliberate, human-in-the-loop
  step (the "Publish as MCP tool" button in `Chat.tsx`, after the user has
  actually exercised the agent) — not a side effect of every bootstrap.
  `GET /agents` lists published agents (used by `Setup.tsx`'s management
  list); `DELETE /agents/<id>` unpublishes. `tool_name` is a slugified,
  deduplicated identifier derived from `name` — the literal MCP tool name a
  client calls, fixed once assigned.
- **Separate ASGI process, not new Flask routes.** The official `mcp` SDK's
  HTTP transports (`mcp.server.sse`, `mcp.server.streamable_http_manager`)
  are Starlette/ASGI-only (confirmed by their own imports) and the SDK ships
  no WSGI transport, so this can't be routes on the Flask/gunicorn app.
  `backend/mcp_server.py` runs as its own `uvicorn` process — dev: `python
  backend/mcp_server.py` (port `4892`, `MCP_PORT` to override); prod: the
  `aiagent-mcp` systemd unit on port `8788`, proxied at `/mcp` (see
  Deployment). It lives next to `server.py` (not in `src/`) because, like
  `server.py`, it's a runnable entrypoint, not a library module.
  Transport is **Streamable HTTP** (`StreamableHTTPSessionManager`), the
  current MCP spec's recommended transport, not SSE.
- **Low-level `Server` API, not `FastMCP`.** `FastMCP`'s `@mcp.tool()`
  decorator fixes the tool list at import time; here the tool list is
  `agent_registry.list_agents()`, which changes as agents are
  published/unpublished, so `list_tools()`/`call_tool()` need to be handlers
  re-invoked fresh on every request — confirmed by reading
  `mcp/server/lowlevel/server.py`, which is exactly what those decorators
  give you. No MCP-server restart is needed after a publish/unpublish.
- **Thin wrapper over the existing execution path, not new agent logic.**
  Each published agent becomes one tool taking a single `message` string.
  `call_tool()`'s `_run_once()` builds `messages = [{"role": "user",
  "content": message}]` and drives the *existing* `run_agent_stream(messages,
  agent_config)` generator (via `asyncio.to_thread`, since it's a blocking
  generator) to completion, returning the `"done"` event's `response` field
  — same "reuse the execution path" principle as `orchestrator.run_worker()`
  for delegated workers. One call in, one call out; no server-side
  conversation carried between MCP tool calls, consistent with "the backend
  is stateless" (Frontend Patterns below).

---

## Frontend Patterns

### Phase transitions

`App.tsx` owns phase state (`setup | bootstrapping | chat`). Phase transitions happen via callbacks passed down to `Setup`:
- `onStart` → set `bootstrapping`
- `onDone(config)` → set `chat` + store `AgentConfig`
- `onError(msg)` → revert to `setup` + show error

### Message history

`Chat.tsx` owns the message array. On each send:
1. Append user message to local state immediately
2. Serialize to `Message[]` (stripping `toolCalls` which are UI-only)
3. POST to `/agent` with full history + `AgentConfig`
4. Append assistant response with `toolCalls` for display

The backend is stateless — full history travels with every request.

### API base URL

Controlled by `VITE_API_URL` env var. Defaults to `http://localhost:3000` (SAM local) if unset. Set at build time for production.

---

## Local Development

No SAM or Docker needed day-to-day — see `RUNNING_LOCALLY.md` for full setup. Short version:

```bash
# Backend — in project root (reads credentials from env.json)
python backend/server.py

# Frontend — in a second terminal
cd frontend && npm install && npm run dev
```

`server.py` listens on `localhost:3000`; Vite dev server on `localhost:5173` and proxies `/bootstrap`+`/agent` to it. `sam local start-api` still works as an alternative (exercises `handler.py`/Lambda code instead) but isn't the day-to-day path.

---

## Deployment

Production is a **systemd + nginx droplet** (`agent.carkus.com` on the
carkus.com box), not AWS — the AWS SAM/Lambda path (`template.yaml`) is kept
only for `sam local` dev and is not deployed anywhere. Full first-time setup
and rationale: [`DEPLOY.md`](./DEPLOY.md).

- Backend runs as `gunicorn server:app` under the `aiagent` systemd unit (`deploy/aiagent.service`), single worker process + 4 threads (rate-limit counters are process-local — don't raise `--workers`)
- The MCP server (`backend/mcp_server.py`) runs as a **separate** `uvicorn mcp_server:app` process under its own `aiagent-mcp` systemd unit (`deploy/aiagent-mcp.service`), port `8788` — a structurally distinct ASGI process from gunicorn's WSGI one, not another route on it (see Backend Patterns' "AIAgent as an MCP server")
- nginx (`deploy/nginx-aiagent.conf`) serves the built frontend and reverse-proxies `/bootstrap`, `/agent`, `/models`, `/file/`, `/agents` to gunicorn on `127.0.0.1:8787`, and `/mcp` to uvicorn on `127.0.0.1:8788`; one shared HTTP Basic Auth login gates the whole app (frontend + both APIs)
- Production is **Gemini-only** — the droplet's existing Ollama instance is sized for a different app's tiny fallback model and can't fit this app's bootstrap-quality model
- Secrets live in `/var/www/aiagent/.env` (`EnvironmentFile=`, mode 600), not inline in the unit file

Ship a code change with:

```bash
deploy/redeploy.sh backend    # sync backend/src + requirements, restart both the aiagent and aiagent-mcp services
deploy/redeploy.sh frontend   # npm run build locally, ship dist/, fix ownership
deploy/redeploy.sh all        # both
```

Run from the repo root; requires SSH access to the droplet (no git or CI there — code is shipped as a tarball).

---

## Current Limitations

### 1. ~~API Gateway 29-second timeout~~ — resolved in production
Production doesn't go through API Gateway at all (see Deployment) — gunicorn's `--timeout 300` covers the longest expected agent loop. Only the dev-only `sam local` path still has this ceiling.

### 2. Tool execution security (`exec()` in-process)
Gemini-generated code runs in-process (Lambda in dev, the `aiagent` gunicorn worker in prod). A builtins allowlist is in place but is not a full sandbox. **Next step:** process isolation per tool call, or adopt RestrictedPython.

### 3. No server-side conversation persistence
Chat history lives in React state; a "Save chat" button (`chatStorage.ts`) persists finished/in-progress conversations to the browser's `localStorage` so a refresh doesn't lose them, but nothing is stored server-side — saved chats don't follow the user across browsers/devices. **Next step, if needed:** a session table server-side.

### 4. ~~No streaming / progress feedback~~ — resolved
`agent_stream.py`'s `run_agent_stream` streams `tool_start`/`tool_result`/`done` NDJSON events end-to-end (Flask → nginx `proxy_buffering off` → `Chat.tsx`'s `StreamEvent` handling); the UI shows tool calls live as they happen, not just after the loop completes.

### 5. Authentication is perimeter-only
Production sits behind one shared nginx HTTP Basic Auth login (frontend + API alike — see Deployment) rather than per-user accounts; anyone with that one login can use the whole app. Fine for a single-operator/demo deployment, not for multi-user access control.

### 6. File output is ephemeral
The `save_output` tool writes to the backend process's `/tmp/`, served back via `GET /file/<name>` — lost on restart/redeploy, and (in prod) shared across all users of the one shared login rather than scoped per session. **Next step:** write to S3 (or equivalent) and return a pre-signed URL.

### 7. AgentConfig not persisted server-side — partially addressed
A saved chat's `AgentConfig` still round-trips through `localStorage` (see limitation 3 above) for the "reload this browser's chat" case — no cross-device or server-side store for that. But an explicit **publish** step now does add server-side persistence for the narrower case of "expose this agent as a callable tool": `agent_registry.py` (file-store, `data/agent_registry.json`) backs `mcp_server.py`'s MCP tool list (see Backend Patterns above). It's deliberately not a general session/history store — just enough persistence for a chosen `AgentConfig` to be enumerable and re-runnable outside its original browser session.

### 8. Bootstrap quality is input-dependent — partially addressed
Vague purpose descriptions produce generic tools. The Setup screen's Agent Type preset dropdown (`AGENT_TEMPLATES` in `Setup.tsx`) narrows this by giving Gemini a purpose-built prompt template per type rather than a freeform box. Bootstrap grounding (`bootstrap_memory.py`/`embeddings.py`, see Backend Patterns above) now also feeds the model 1-2 similar past `purpose → config` pairs as few-shot examples once enough bootstraps have accumulated — cold-start behavior (first bootstrap for a given kind of purpose) is unchanged. A structured review/regenerate step before launching chat is still a possible next step.

---

## Roadmap — Multi-Agent Direction

Five forward-looking directions for this project. Captured here as work to accomplish, not as current limitations of the single-agent design — each assumes the existing bootstrap/agent-loop architecture as a starting point rather than a replacement.

### 1. Multi-agent orchestration — first scaffold done
`orchestrator.py`'s `run_worker()` + `agent_stream.py`'s `delegate_to_worker` tool implement the basic version: the main agent can spin up a worker agent (bootstrapped via the same `generate_agent_config` call, own name/personality/toolset, `is_worker=True`) to own one self-contained subtask and hand back its finished result — one level deep, synchronous, capped at `MAX_DELEGATIONS_PER_REQUEST` per turn (see `agent_stream.py`'s module docstring for the deliberate scope limits). Not yet done: a planner agent that decomposes the task itself (today the *main* agent decides when/what to delegate via its own judgment, there's no separate planning phase), recursive sub-worker spawning, and a supervisor pattern beyond "main agent reads the worker's result and continues."

### 2. A2A protocol
AIAgent's dynamically-generated agents are a good target for making A2A-discoverable, since each one already has a defined role/tools. Two AIAgent-spawned agents negotiating a task over A2A instead of just sharing memory internally would be a clean proof-of-concept, and it's a step up from bolting A2A onto Jobfit's fixed three tools.

### 3. Agent memory/context engineering
You've already got "full conversation memory across follow-ups." The freeform extension: memory that persists and is reasoned about across completely different spawned agents — shared long-term memory vs. per-agent scratch memory, summarization/compaction as context grows. Rigid pipelines like Jobfit don't really surface this problem; open-ended agent spawning does.

### 4. Governance/guardrails
Since AIAgent generates Python implementations on the fly, this is actually a sharper testbed than Jobfit for sandboxing and permissioning (what can a dynamically-written tool be allowed to touch?), which is a much more interesting guardrails story than gating three known tools.

### 5. Deployment breadth
Lambda suits AIAgent's request/response scaffolding well, but if you add persistent multi-agent state or long-running orchestration, that's your excuse to stand up an ECS/Fargate or GKE variant and genuinely compare the two, rather than picking one because it's "the AWS option."
