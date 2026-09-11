# Running Locally

Two terminals required — one for the backend (Flask), one for the frontend (Vite).

> **No Docker or SAM required for local development.** The backend runs as a plain Python Flask server. SAM and Docker are only needed when deploying to AWS or testing Lambda-specific behaviour.

---

## Prerequisites

| Tool | Version | Install | Verify |
|------|---------|---------|--------|
| Python | 3.12+ | [python.org](https://www.python.org/downloads/) | `python --version` |
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) | `node --version` |
| Gemini API key | — | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | — |
| Ollama (optional, local-only fallback) | — | [ollama.com](https://ollama.com/) | `ollama list` |

---

## Step 1 — Configure environment

Create `env.json` in the project root. The backend server reads credentials from this file automatically.

```json
{
  "BootstrapFunction": {
    "GEMINI_API_KEY": "your-gemini-key-here"
  },
  "AgentFunction": {
    "GEMINI_API_KEY": "your-gemini-key-here",
    "ADZUNA_APP_ID": "your-app-id",
    "ADZUNA_APP_KEY": "your-app-key"
  }
}
```

> To use the local-only Ollama fallback instead of/alongside Gemini, no key is needed — just have `ollama serve` running with a model pulled (`ollama pull qwen2.5-coder`). Set `OLLAMA_MODEL`/`OLLAMA_BASE_URL` env vars to override the defaults, or `LLM_PROVIDER=ollama` to force it. See [CLAUDE.md](./CLAUDE.md) for the full cascade behaviour.
>
> **Keep `env.json` out of source control.** It is already listed in `.gitignore`.

Create `frontend/.env.local`:

```
VITE_API_URL=
```

> Leave `VITE_API_URL` empty. The Vite dev server proxies `/bootstrap` and `/agent` to `localhost:4891` automatically — no value needed.

---

## Step 2 — Install backend dependencies

```powershell
pip install -r backend/requirements.txt
```

---

## Step 3 — Install frontend dependencies

```powershell
cd frontend
npm install
cd ..
```

---

## Step 4 — Start the backend (Terminal 1)

```powershell
python backend/server.py
```

Expected output:

```
Starting local dev server on http://localhost:4891
 * Running on http://127.0.0.1:4891
```

The server reads `env.json` on startup and hot-reloads when you edit files in `backend/src/`.

---

## Step 4.5 — Start the MCP server (Terminal 3, optional)

Only needed if you want to test AIAgent's own MCP-server side (published
agents exposed as MCP tools other clients can call — see
[CLAUDE.md](./CLAUDE.md)'s "AIAgent as an MCP server" section). It's a
separate process from the Flask backend, since the `mcp` SDK's HTTP
transport is ASGI, not WSGI:

```powershell
python backend/mcp_server.py
```

```
Starting MCP server on http://localhost:4892/mcp
```

Publish an agent first (the "Publish as MCP tool" button in Chat, after
bootstrapping and chatting with one), then point any MCP client at
`http://localhost:4892/mcp`.

---

## Step 5 — Start the frontend (Terminal 2)

```powershell
cd frontend
npm run dev
```

Expected output:

```
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:19173/
```

Open [http://localhost:19173](http://localhost:19173) in your browser.

---

## Verifying It Works

1. The app loads and shows the **Setup** screen with a text area
2. Type a purpose (e.g. `Research a company and write a one-page summary`)
3. Click **Create Agent** — the UI shows "Configuring agent..." for ~10 seconds
4. The **Chat** screen appears with the generated tool badges at the top
5. Send a message — tool calls appear live as the agent works, then the final response arrives

If step 3 errors, check the backend terminal for the Python traceback.

---

## Making Backend Changes

The Flask server hot-reloads automatically. Edit any file in `backend/src/`, save, and the next request picks up the change — no restart needed.

---

## Making Frontend Changes

Vite hot-reloads automatically. Edit any file in `frontend/src/` and the browser updates instantly.

---

## Changing the Port

The backend defaults to port `4891` (deliberately not `3000`/`5000`/`8000`, which tend to collide with other projects' dev servers). If `4891` is also taken, override it:

```powershell
$env:PORT=3987
python backend/server.py
```

Then update `frontend/vite.config.ts` to proxy to the new port — it has five routes to change (`/bootstrap`, `/agent`, `/file`, `/models`, `/saved-searches`):

```ts
proxy: {
  '/bootstrap': 'http://localhost:3987',
  '/agent': 'http://localhost:3987',
  '/agents': 'http://localhost:3987',
  '/file': 'http://localhost:3987',
  '/models': 'http://localhost:3987',
  '/saved-searches': 'http://localhost:3987',
}
```

The MCP server (`backend/mcp_server.py`) has its own port, `4892`, overridable via `MCP_PORT` — it's a separate process from the Flask backend, not proxied by Vite (MCP clients connect to it directly, not through the frontend).

**Auth:** unset `MCP_API_KEY` locally (the default) leaves `/mcp` open, same as today. Set `MCP_API_KEY` to require every request to send a matching `X-Api-Key` header (or `?key=` query param) — see DEPLOY.md for the production story.

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'openai'` (or `flask`, `requests`)**

The Python packages aren't installed in your local environment. Run:

```powershell
pip install -r backend/requirements.txt
```

---

**`Bootstrap failed` or request returns an error immediately**

Open browser DevTools → Network tab and check the `/bootstrap` request:

- `net::ERR_CONNECTION_REFUSED` → the backend isn't running. Start it with `python backend/server.py`.
- `500` response → check the backend terminal for the Python traceback.

---

**Browser console shows CORS error**

The Flask server handles CORS directly, so this should not occur. If it does, confirm `frontend/.env.local` has `VITE_API_URL=` (empty, not `http://localhost:4891`) and that the Vite dev server was restarted after the change.

---

**Bootstrap returns `Unterminated string` / JSON parse error**

Claude's response was cut off before finishing the JSON. This means `max_tokens` in `bootstrap.py` was too low for the generated config. It is currently set to `16000`, which should be sufficient. If it recurs with a very detailed purpose description, try simplifying the description.

---

**`env.json` credentials not being picked up**

The server loads `env.json` from the project root (the directory containing `backend/` and `frontend/`). Make sure you are running `python backend/server.py` from the project root, not from inside `backend/`.

---

## Deploying to AWS

SAM and Docker are only needed for deployment:

```powershell
# Install SAM CLI: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
sam build --use-container
sam deploy --guided   # first time — prompts for GeminiApiKey and other params
sam deploy            # subsequent deploys
```

After deploy, build the frontend with the API Gateway URL from SAM outputs:

```powershell
cd frontend
$env:VITE_API_URL="https://<api-id>.execute-api.<region>.amazonaws.com/Prod"
npm run build
```

Host `frontend/dist/` on S3 + CloudFront, Amplify, or Netlify.
