# AI Agent — Self-Scaffolding Agent Platform

Most AI tools make you fit your problem to their interface. This one works the other way around.

Describe what you want an agent to do — in plain language, no configuration files, no code — and the platform builds it: the role, the tools, the implementation. A job market researcher. A competitive analysis engine. A document processor. A data pipeline. Each one purpose-built, on demand, ready to work.

And once it starts, it doesn't forget. Every tool call, every search result, every piece of analysis stays in context. Ask follow-up questions, dig deeper, change direction — the agent carries the full thread of the conversation. It's not a one-shot query tool. It's a researcher you can talk to.

---

## What You Can Do With It

Tell it what you need. It figures out the rest.

```
"Research Flutter developer job availability in Melbourne —
 volume, seniority mix, salary ranges, top hiring companies."
```

The agent bootstraps itself with the right tools for that task — job board search, data analysis, report writing — then works through the problem autonomously, calling tools in sequence, reasoning over results, and delivering a structured answer.

Then keep going:

> *"Which of those companies had the highest salary range?"*
> *"Now filter to senior roles only and compare the demand."*
> *"Summarise everything into a table I can share."*

The agent remembers everything. The full conversation history travels with every request. Treat it like talking to a specialist who did the work and is sitting there ready for follow-up — not a search box you ping once and move on from.

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Phase 1: Bootstrap                                     │
│                                                         │
│  User describes purpose                                 │
│       │                                                 │
│       ▼                                                 │
│  Claude (claude-opus-4-8) generates:                    │
│    • system_prompt  — role, personality, approach       │
│    • tools[]        — name, description, input_schema   │
│                       + Python implementation code      │
│                                                         │
│  Result stored in React state as AgentConfig            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Phase 2: Agent Loop                                    │
│                                                         │
│  User sends message                                     │
│       │                                                 │
│       ▼                                                 │
│  Claude runs with dynamic tool schemas                  │
│       │                                                 │
│       ├── tool_use → execute Python impl → result       │
│       ├── tool_use → ...                                │
│       └── end_turn → final response returned to UI      │
└─────────────────────────────────────────────────────────┘
```

The tool implementations are Python snippets written by Claude during bootstrap and executed via `exec()` inside the Lambda function. Tools have access to `inputs` (their arguments), the `requests` library, `json`, and `os`.

---

## Stack

| Layer    | Technology                              |
|----------|-----------------------------------------|
| Frontend | React 18, TypeScript, Vite              |
| Backend  | Python 3.12, AWS Lambda, API Gateway    |
| AI       | Anthropic Claude API (`claude-opus-4-8`)|
| IaC      | AWS SAM                                 |

---

## Project Structure

```
AIAgent/
├── backend/
│   ├── src/
│   │   ├── handler.py       # Lambda entry point — routes /bootstrap and /agent
│   │   ├── bootstrap.py     # Calls Claude to generate AgentConfig from purpose
│   │   ├── agent.py         # Agentic loop — calls tools until end_turn
│   │   └── tools.py         # Executes Claude-generated Python tool implementations
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx                    # Phase state machine: setup → bootstrapping → chat
│   │   ├── api.ts                     # Typed fetch wrappers for /bootstrap and /agent
│   │   ├── types.ts                   # Shared TypeScript types
│   │   └── components/
│   │       ├── Setup.tsx              # Purpose input form
│   │       ├── Chat.tsx               # Chat UI with message history
│   │       └── ToolActivity.tsx       # Inline display of tool calls + results
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── template.yaml            # SAM template — two Lambda functions, one API Gateway
└── .env.example
```

---

## Prerequisites

- Python 3.12+
- Node.js 18+
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials
- Anthropic API key

---

## Local Development

**1. Clone and configure environment**

```bash
cp .env.example .env
# Edit .env — fill in your ANTHROPIC_API_KEY
```

**2. Start the backend (SAM local)**

```bash
sam build --use-container
sam local start-api --env-vars env.json
# API available at http://localhost:3000
```

**3. Start the frontend (separate terminal)**

```bash
cd frontend
npm install
npm run dev
# UI available at http://localhost:5173
```

---

## Deployment

**1. Build**

```bash
sam build
```

**2. Deploy (guided first-time setup)**

```bash
sam deploy --guided
# When prompted, provide your ANTHROPIC_API_KEY as a parameter
```

**3. Update `VITE_API_URL` and build the frontend**

After deploy, SAM outputs the API Gateway URL. Set it before building:

```bash
cd frontend
VITE_API_URL=https://<your-api-id>.execute-api.<region>.amazonaws.com/Prod npm run build
```

Upload the `dist/` folder to S3 + CloudFront, or drag it into Amplify / Netlify.

---

## Environment Variables

| Variable          | Where          | Description                                      |
|-------------------|----------------|--------------------------------------------------|
| `ANTHROPIC_API_KEY` | Lambda (env) | Your Anthropic API key — never sent to browser   |
| `VITE_API_URL`    | Frontend build | Base URL of the deployed API (or `localhost:3000`)|

---

## Current Limitations and Proposed Solutions

### 1. API Gateway 29-second hard timeout

**Problem:** API Gateway cuts off any request that takes longer than 29 seconds. Complex agent tasks with many tool calls can exceed this.

**Proposed solutions:**
- **Lambda Function URLs with response streaming** — bypasses API Gateway; responses stream token-by-token to the browser via SSE. This is the recommended next step.
- **Async pattern** — Lambda immediately returns a job ID; client polls a `/status/{job_id}` endpoint backed by DynamoDB until the result is ready.
- **WebSockets via API Gateway** — bidirectional connection; Lambda pushes progress events as they happen. More complex to implement but enables real-time tool activity streaming.

---

### 2. Tool implementations run in-process via `exec()`

**Problem:** Claude-generated Python code runs inside the Lambda process via `exec()`. A malformed or malicious implementation could affect the Lambda runtime, exhaust memory, or make unintended network calls. The current builtins allowlist reduces but does not eliminate risk.

**Proposed solutions:**
- **Separate Lambda per tool execution** — invoke a dedicated "tool runner" Lambda for each tool call. Isolation is complete; a crash does not affect the agent loop.
- **[RestrictedPython](https://github.com/zopefoundation/RestrictedPython)** — a library that compiles Python to a restricted AST, blocking dangerous constructs before execution.
- **AWS Lambda `--use-container` / Firecracker microVMs** — run each tool call inside a fresh microVM for true sandboxing.
- **Anthropic Managed Agents** — Anthropic's hosted agent platform provides a managed sandbox (bash, file ops, code execution) and removes the need to run tool code yourself.

---

### 3. No conversation persistence

**Problem:** The full message history is sent from the browser on every request. Long conversations bloat the request payload, and history is lost on page refresh.

**Proposed solutions:**
- **DynamoDB session table** — store messages server-side keyed by `session_id`. Frontend sends only the new message; Lambda loads history, appends, and saves back.
- **AgentConfig caching** — the bootstrap result (system prompt + tools) is held in React state. If the page refreshes, the user must re-bootstrap. Store AgentConfig in DynamoDB alongside the session, keyed by `session_id` in `localStorage`.

---

### 4. No streaming responses

**Problem:** The UI shows "Working..." with no progress feedback until the entire agent loop finishes. For tasks with multiple tool calls this can feel unresponsive.

**Proposed solutions:**
- **Lambda Function URLs + SSE** — stream each token and tool-call event from the Lambda as it happens. Requires replacing API Gateway with a Function URL and updating the agent loop to use `client.messages.stream()`.
- **WebSocket push** — Lambda sends events to a WebSocket connection managed by API Gateway WebSocket API as the agent progresses.

---

### 5. No authentication or rate limiting

**Problem:** The API endpoints are open. Anyone with the URL can send requests and incur Claude API costs.

**Proposed solutions:**
- **API Gateway usage plans + API keys** — simple; attach an API key header to frontend requests.
- **Amazon Cognito** — full user auth with JWT tokens validated by an API Gateway authorizer.
- **Lambda-side rate limiting** — track calls per IP/user in DynamoDB with a TTL-based counter.

---

### 6. Lambda cold starts

**Problem:** The first request after a period of inactivity incurs a cold start (~1–2 seconds for Python). This adds to already-noticeable latency on the bootstrap call.

**Proposed solutions:**
- **Provisioned concurrency** — keeps N Lambda instances warm at all times. Costs money even when idle.
- **Scheduled warm-up ping** — EventBridge rule fires a no-op request every few minutes to keep the Lambda warm. Cheap but not guaranteed.

---

### 7. File output is ephemeral

**Problem:** The generated `save_output` tool writes to Lambda `/tmp/`, which is destroyed when the invocation ends. Files cannot be retrieved by the user.

**Proposed solutions:**
- **S3 pre-signed URLs** — the `save_output` tool writes to S3 instead of `/tmp/`. Lambda returns a pre-signed URL in the tool result; the frontend renders it as a download link.
- **Return file content directly** — for small outputs, embed the file content in the agent's final response.

---

### 8. Bootstrap quality depends on purpose description

**Problem:** Vague purpose descriptions produce generic tools. If the user writes "help me with stuff", Claude generates unhelpful tools.

**Proposed solutions:**
- **Guided purpose form** — add structured fields (goal, data sources, output format) alongside the free-text area to give Claude more signal.
- **Bootstrap review step** — show the user the generated system prompt and tool list before launching the chat, with an option to regenerate or edit.
- **Iterative refinement** — let the agent ask clarifying questions in its first message before committing to a tool set.
