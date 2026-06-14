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

## Step 3 — Build the backend

From the project root:

```powershell
sam build --use-container
```

The `--use-container` flag builds the Lambda packages inside a Docker container with the correct Python 3.12 environment. This avoids issues with local Python version mismatches and is the recommended approach on Windows.

SAM will pull the build image on first run (~1 minute). Subsequent builds are faster.

Expected output:

```
Build Succeeded

Built Artifacts  : .aws-sam/build
Built Template   : .aws-sam/build/template.yaml
```

> **Re-run this whenever you change backend code.** SAM does not hot-reload — a rebuild + restart is always required.

---

## Step 4 — Start the backend (Terminal 1)

```powershell
sam local start-api --env-vars env.json
```

SAM will pull the Lambda Docker image on first run (~1 minute). Subsequent starts are fast.

Expected output:

```
Mounting BootstrapFunction at http://127.0.0.1:3000/bootstrap [POST]
Mounting AgentFunction at http://127.0.0.1:3000/agent [POST]
You can now browse to the above endpoints to invoke your functions.
```

> Each request spins up a fresh Docker container. The first request after startup takes a few seconds. This is normal — cold start behaviour is expected locally.

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

After editing any file in `backend/src/`:

```powershell
# Terminal 1 — stop SAM (Ctrl+C), then:
sam build --use-container && sam local start-api --env-vars env.json
```

SAM local does not hot-reload. A rebuild + restart is required for each backend change.

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
