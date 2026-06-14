# Running Locally

Two terminals required — one for the backend (SAM local), one for the frontend (Vite dev server).

---

## Prerequisites

Install these before starting. Check marks indicate what to verify after installing.

| Tool | Version | Install | Verify |
|------|---------|---------|--------|
| Python | 3.12+ | [python.org](https://www.python.org/downloads/) | `python --version` |
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) | `node --version` |
| AWS SAM CLI | latest | [Install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | `sam --version` |
| Docker Desktop | latest | [docker.com](https://www.docker.com/products/docker-desktop/) | `docker info` |
| Anthropic API key | — | [console.anthropic.com](https://console.anthropic.com/) | — |

> **Docker is required.** SAM local runs Lambda functions inside Docker containers. Docker Desktop must be running before you start the backend.

---

## Step 1 — Configure environment

Create the environment files from the example:

```powershell
# Project root
Copy-Item .env.example env.json.example
```

Create `env.json` in the project root with your API key:

```json
{
  "BootstrapFunction": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key-here"
  },
  "AgentFunction": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key-here"
  }
}
```

Create `frontend/.env.local` for the frontend:

```
VITE_API_URL=http://localhost:3000
```

> **Keep `env.json` and `frontend/.env.local` out of source control.** They are already in `.gitignore` if you set one up — add them if not.

---

## Step 2 — Install frontend dependencies

```powershell
cd frontend
npm install
cd ..
```

---

## Step 3 — Install backend dev dependencies

The local dev server uses Flask for streaming support (SAM local cannot stream responses).

```powershell
pip install flask anthropic requests
```

> These are installed into your local Python environment, not the Lambda package. You do not need Docker or SAM to run the backend locally.

---

## Step 4 — Start the backend (Terminal 1)

```powershell
python backend/server.py
```

Expected output:

```
Starting local dev server on http://localhost:3000
 * Running on http://127.0.0.1:3000
```

The Flask server hot-reloads on file changes in `backend/src/` — no restart needed when editing Python files.

> **SAM local is only needed for deployment testing.** For day-to-day development, use `backend/server.py`. If you do need SAM local (e.g. to test Lambda-specific behaviour), run `sam build --use-container && sam local start-api --env-vars env.json` — but note SAM local does not support streaming responses.

---

## Step 5 — Start the frontend (Terminal 2)

```powershell
cd frontend
npm run dev
```

Expected output:

```
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Verifying It Works

1. The app loads and shows the **Setup** screen with a text area
2. Type a purpose (e.g. `Research a company and write a one-page summary`)
3. Click **Create Agent** — the UI should show "Configuring agent..." for ~10 seconds
4. The **Chat** screen appears showing the generated tool badges at the top
5. Send a message — the agent calls tools and returns a response

If step 3 hangs or errors, check the SAM terminal for the Lambda log output.

---

## Making Backend Changes

The Flask dev server (`backend/server.py`) picks up changes to `backend/src/` automatically — just save the file and the next request will use the updated code. No restart needed.

---

## Making Frontend Changes

Vite hot-reloads automatically. Edit any file in `frontend/src/` and the browser updates instantly — no restart needed.

---

## Troubleshooting

**`sam build` fails with "Binary validation failed for python" / "Do you have python for runtime: python3.12"**

SAM can't find a local Python 3.12 installation that matches the Lambda runtime. Use the container build instead — it supplies its own Python:

```powershell
sam build --use-container
```

---

**Lambda logs show `No module named 'anthropic'`**

`requirements.txt` must live inside `backend/src/` (alongside `handler.py`), not in `backend/`. SAM resolves dependencies relative to `CodeUri`. Verify the file exists at `backend/src/requirements.txt`, then rebuild:

```powershell
sam build --use-container
```

---

**`sam build` fails with "No module named..."**

SAM builds Lambda packages inside Docker. Make sure Docker Desktop is running before running `sam build`.

---

**Request returns 502 or times out**

Check the SAM terminal. Common causes:
- `ANTHROPIC_API_KEY` is missing or incorrect in `env.json`
- Docker container failed to start — try `docker ps` to confirm Docker is healthy
- The bootstrap prompt returned invalid JSON — check the Lambda log for a `json.JSONDecodeError`

---

**`docker info` returns "Cannot connect to the Docker daemon"**

Docker Desktop is not running. Start it and wait for the whale icon to appear in the system tray before retrying.

---

**Port 3000 already in use**

```powershell
sam local start-api --env-vars env.json --port 3001
```

Update `frontend/.env.local` to match:

```
VITE_API_URL=http://localhost:3001
```

---

### Browser console shows CORS error / "No 'Access-Control-Allow-Origin' header"

SAM local does not emulate API Gateway's CORS handling. The Vite dev server proxy sidesteps this — requests go to Vite (same origin) and Vite forwards them to SAM. Check that:

1. `frontend/vite.config.ts` has the proxy block:

   ```ts
   proxy: {
     '/bootstrap': 'http://localhost:3000',
     '/agent': 'http://localhost:3000',
   }
   ```

2. `frontend/.env.local` has `VITE_API_URL=` (empty — not `http://localhost:3000`)
3. The Vite dev server was restarted after making those changes

---

**Frontend shows "Bootstrap failed" immediately**

Open browser DevTools → Network tab. Check the request to `/bootstrap`:
- `net::ERR_CONNECTION_REFUSED` → SAM backend is not running or is on a different port
- `500` response → check the SAM terminal for the Python traceback

---

**First request is very slow (30+ seconds)**

This is the Docker cold start on first run. Subsequent requests in the same session are faster. If you need consistently faster local starts, use `--warm-containers EAGER`:

```powershell
sam local start-api --env-vars env.json --warm-containers EAGER
```

This keeps containers alive between requests at the cost of higher local memory use.
