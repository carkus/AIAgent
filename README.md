# AI Agent — Self-Scaffolding Agent Platform

Most AI tools make you fit your problem to their interface. This one works the other way around.

Describe what you want an agent to do — in plain language, no configuration files, no code — and the platform builds it: the role, the tools, the implementation. A job market researcher. A competitive analysis engine. A document processor. A data pipeline. Each one purpose-built, on demand, ready to work.

And once it starts, it doesn't forget. Every tool call, every search result, every piece of analysis stays in context. Ask follow-up questions, dig deeper, change direction — the agent carries the full thread of the conversation. It's not a one-shot query tool. It's a researcher you can talk to.

The platform can also delegate: a request naming several distinct topics ("Python developer, React developer, DevOps engineer" — or "renewable energy, EV batteries, grid storage") spins up one disposable worker agent per topic, each with its own tools, searching and reporting back independently, capped at 6 per turn.

---

## What You Can Do With It

Tell it what you need. It figures out the rest.

```
"Research Flutter developer job availability in Melbourne —
 volume, seniority mix, salary ranges, top hiring companies."
```

The agent bootstraps itself with the right tools for that task — job board search, data analysis, report writing — then works through the problem autonomously, calling tools in sequence, reasoning over results, and delivering a structured answer. Where the findings are a comparison, a distribution, or a multi-step flow, the agent draws a Mermaid diagram instead of a wall of prose.

Then keep going:

> *"Which of those companies had the highest salary range?"*
> *"Now filter to senior roles only and compare the demand."*
> *"Summarise everything into a table I can share."*

The agent remembers everything. The full conversation history travels with every request. Treat it like talking to a specialist who did the work and is sitting there ready for follow-up — not a search box you ping once and move on from.

---

## How It Works

```
┌───────────────────────────────────────────────────────────────┐
│  Phase 1: Bootstrap  (POST /bootstrap, streamed)               │
│                                                                 │
│  User describes purpose                                        │
│       │                                                         │
│       ▼                                                         │
│  Gemini (⟶ Ollama fallback, dev-only) generates AgentConfig:   │
│    • system_prompt  — role, personality, approach              │
│    • tools[]        — name, description, input_schema, and     │
│                        either a Python implementation string   │
│                        or a source: "mcp" reference to a real,  │
│                        vetted MCP server tool                  │
│  Grounded by: 1-2 similar past bootstraps (RAG, bootstrap_memory)│
│               + the live vetted-MCP-server tool catalog        │
│                                                                 │
│  Result stored in React state as AgentConfig                   │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│  Phase 2: Agent Loop  (POST /agent, streamed NDJSON)           │
│                                                                 │
│  User sends message                                             │
│       │                                                         │
│       ▼                                                         │
│  Gemini (⟶ Ollama fallback, dev-only) runs with dynamic tools  │
│       │                                                         │
│       ├── tool_use (generated)  → exec() the implementation     │
│       ├── tool_use (source:mcp) → route to the real MCP server  │
│       ├── tool_use (delegate_to_worker) → bootstrap + run a     │
│       │      one-shot worker agent, hand back its result        │
│       └── end_turn → final response streamed to the UI          │
└───────────────────────────────────────────────────────────────┘
```

A bootstrapped agent that's actually been exercised in chat can also be
**published** as a standing MCP tool (`backend/mcp_server.py`, its own
process), so any MCP client — Claude Desktop, Claude Code, another AIAgent
instance — can call it directly, not just this project's own frontend.

---

## Stack

| Layer    | Technology                                                      |
|----------|------------------------------------------------------------------|
| Frontend | React 18, TypeScript, Vite, `react-markdown` + `mermaid` for diagrammed replies |
| Backend  | Python 3.12, Flask + gunicorn (WSGI, chat/bootstrap API), a second `uvicorn`/Starlette (ASGI) process for the MCP server |
| AI       | Gemini (primary) → Ollama (local-only dev fallback) |
| Tool sourcing | Gemini-generated Python (`exec()`), or real tools from vetted MCP servers via the official `mcp` SDK |
| Hosting  | systemd + nginx on a droplet (`agent.carkus.com`); no container orchestration, no CI — deployed by tarball over SSH |

An AWS SAM/Lambda path (`template.yaml`, `backend/src/handler.py`) still
exists in the repo as **dev-only tooling** (`sam local`) — it is not what's
deployed. Don't expect changes to `handler.py` to reach production; see
[`AIAgent/CLAUDE.md`](./CLAUDE.md) for the full architecture rationale.

---

## Project Structure

```
AIAgent/
├── backend/
│   ├── server.py            # Flask app — actual runtime for dev + prod: /bootstrap, /agent, /models, /agents, /file/<name>
│   ├── mcp_server.py         # Separate uvicorn/ASGI process — exposes published agents as MCP tools over Streamable HTTP
│   ├── src/
│   │   ├── bootstrap.py         # Streams the bootstrap call; grounds it with few-shot examples + vetted MCP catalog
│   │   ├── agent_stream.py      # The agentic loop that actually runs in prod (streamed tool_start/tool_result/done)
│   │   ├── orchestrator.py      # Multi-agent scaffold — bootstraps + runs a delegated worker agent
│   │   ├── llm_client.py        # Gemini → Ollama cascade
│   │   ├── embeddings.py        # Embeddings for bootstrap RAG grounding (Gemini or Ollama)
│   │   ├── bootstrap_memory.py  # File-store of past purpose → config pairs, powers few-shot retrieval
│   │   ├── mcp_registry.py      # Directory of vetted MCP servers bootstrap can pick a real tool from
│   │   ├── mcp_client.py        # Sync wrapper around the official MCP SDK's stdio client
│   │   ├── agent_registry.py    # File-store of published agents — backs mcp_server.py's tool list
│   │   ├── tools.py             # exec()'s Gemini-generated tool implementations; primitive tools (fetch_page, search_jobs)
│   │   ├── rate_limit.py        # Per-IP rate limiting
│   │   ├── handler.py, agent.py # AWS SAM/Lambda path — dev-only (sam local), not deployed
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx                    # Phase state machine: setup → bootstrapping → chat
│   │   ├── api.ts                     # Typed fetch wrappers for /bootstrap, /agent, /agents, /models
│   │   ├── types.ts                   # Shared TypeScript types
│   │   └── components/
│   │       ├── Setup.tsx              # Purpose input form + published-agent management
│   │       ├── Chat.tsx               # Chat UI, message history, Mermaid-fence rendering
│   │       ├── ToolActivity.tsx        # Collapsible tool-call log + per-worker result cards
│   │       └── MermaidDiagram.tsx      # Renders a ```mermaid fence as an SVG chart
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── deploy/
│   ├── redeploy.sh                # One-command redeploy: tar/scp backend, npm build + ship frontend, restart services
│   ├── aiagent.service            # systemd unit — gunicorn (Flask, WSGI)
│   ├── aiagent-mcp.service        # systemd unit — uvicorn (MCP server, ASGI)
│   └── nginx-aiagent.conf
├── template.yaml            # AWS SAM template — dev-only (sam local), not deployed
└── .env.example
```

---

## Prerequisites

- Python 3.12+
- Node.js 18+
- A Gemini API key (production and default dev path)
- [Ollama](https://ollama.com/) — optional, for a fully local/offline dev fallback (no cloud calls)
- AWS SAM CLI — optional, only if you want to exercise the dev-only Lambda path via `sam local`

---

## Local Development

No SAM or Docker needed day-to-day. Full first-time setup: [`RUN.md`](./RUN.md).

```bash
# Backend — from the repo root (reads credentials from env.json / .env)
python backend/server.py

# Frontend — in a second terminal
cd frontend
npm install
npm run dev
```

`server.py` listens on `localhost:3000`; the Vite dev server on
`localhost:5173` proxies `/bootstrap`, `/agent`, `/agents`, `/models` to it.
To also exercise the MCP-server side (publishing an agent and calling it
from an MCP client), run `python backend/mcp_server.py` in a third terminal
(default port `4892`).

`sam local start-api` still works as an alternative that exercises
`handler.py`/the Lambda code path instead, but it isn't the day-to-day flow.

---

## Deployment

Production is a **systemd + nginx droplet** (`agent.carkus.com`), not AWS —
see [`DEPLOY.md`](./DEPLOY.md) for full first-time setup and rationale.
There is no git or CI on the droplet; code ships as a tarball over SSH.

```bash
deploy/redeploy.sh backend    # sync backend/src + requirements, restart aiagent + aiagent-mcp
deploy/redeploy.sh frontend   # npm run build locally, ship dist/, fix ownership
deploy/redeploy.sh all        # both
```

Run from the repo root; requires SSH access to the droplet.

- `gunicorn server:app` runs the chat/bootstrap API under the `aiagent` systemd unit — single worker process (rate-limit counters are process-local, don't raise `--workers`)
- `uvicorn mcp_server:app` runs the MCP server under its own `aiagent-mcp` systemd unit — a structurally separate ASGI process, since the MCP SDK's HTTP transports are Starlette-only and can't share the Flask/gunicorn app
- nginx serves the built frontend and reverse-proxies API routes to gunicorn and `/mcp` to uvicorn; one shared HTTP Basic Auth login gates the whole app
- Production is Gemini-only — no Ollama fallback in prod

---

## Environment Variables

| Variable          | Where            | Description                                          |
|--------------------|------------------|-------------------------------------------------------|
| `GEMINI_API_KEY`   | Backend env      | Gemini API key — primary provider for bootstrap, chat, and embeddings |
| `OLLAMA_MODEL`     | Backend env (dev) | Local Ollama model name, used only when running `server.py` locally with a local-only agent |
| `MCP_API_KEY`      | Backend env (prod) | Per-consumer API key gating `/mcp` independently of the site's shared login |
| `MCP_PORT`         | Backend env (dev) | Port for `mcp_server.py`'s dev server (default `4892`) |
| `VITE_API_URL`     | Frontend build   | Base URL of the deployed API (defaults to `http://localhost:3000` if unset) |

See `.env.example` for the full list, including the dev-only Lambda/SAM variables.

---

## Current Limitations and Proposed Solutions

### 1. Tool execution security (`exec()` in-process)

**Problem:** Gemini-generated code runs in-process (the `aiagent` gunicorn worker in prod, or locally under `server.py`). A builtins allowlist is in place but is not a full sandbox.

**Proposed solutions:**
- Process isolation per tool call.
- [RestrictedPython](https://github.com/zopefoundation/RestrictedPython) — compiles Python to a restricted AST, blocking dangerous constructs before execution.
- Prefer routing more tool categories through vetted MCP servers (`mcp_registry.py`) instead of generated code — already done for the categories a vetted server exists for; growing that directory removes the exec() risk entirely for the tools it covers.

---

### 2. No server-side conversation persistence

**Problem:** Chat history lives in React state; a "Save chat" button persists it to the browser's `localStorage`, but nothing is stored server-side — saved chats don't follow the user across browsers/devices.

**Proposed solution:** a session table server-side, if cross-device continuity becomes a real need.

---

### 3. Authentication is perimeter-only

**Problem:** Production sits behind one shared nginx HTTP Basic Auth login (frontend and API alike) rather than per-user accounts; anyone with that login can use the whole app. Fine for a single-operator/demo deployment, not for multi-user access control.

**Proposed solutions:**
- Per-user accounts with a real session/token scheme.
- Scope the `/mcp` endpoint's existing per-consumer `MCP_API_KEY` model out to the rest of the API too.

---

### 4. File output is ephemeral

**Problem:** The `save_output` tool writes to the backend process's `/tmp/`, served back via `GET /file/<name>` — lost on restart/redeploy, and shared across all users of the one shared login rather than scoped per session.

**Proposed solution:** write to S3 (or equivalent) and return a pre-signed URL.

---

### 5. Bootstrap quality is input-dependent

**Problem:** Vague purpose descriptions still produce generic tools, especially on the first bootstrap of a given kind of purpose (before any few-shot grounding exists for it).

**Already addressed, partially:**
- The Setup screen's Agent Type preset dropdown narrows freeform input into a purpose-built prompt template per type.
- Bootstrap RAG grounding (`bootstrap_memory.py`/`embeddings.py`) feeds the model 1-2 similar past `purpose → config` pairs as few-shot examples once enough bootstraps have accumulated for that kind of purpose.

**Still open:** a structured review/regenerate step before launching chat, and cold-start quality for a genuinely novel kind of purpose.

---

### 6. AgentConfig persistence is split, not unified

**Problem:** A saved chat's `AgentConfig` round-trips through browser `localStorage` (see limitation 2) for "reload this browser's chat"; separately, an explicit **publish** step (`agent_registry.py`) persists a chosen `AgentConfig` server-side so it can be exposed as an MCP tool. These are two different persistence paths for two different purposes, not one general store.

**Proposed solution:** if a unified server-side store becomes worth the complexity, it would subsume both — but the current split is deliberate (publish is a human-in-the-loop step, not automatic for every bootstrap), not an oversight to fix by default.

---

For the fuller architecture picture — including the Gemini/Ollama provider cascade, the multi-agent delegation scaffold, and the MCP client/server design — see [`AIAgent/CLAUDE.md`](./CLAUDE.md).
