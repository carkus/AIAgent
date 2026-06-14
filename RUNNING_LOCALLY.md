# Running Locally

Two terminals required — one for the backend (Flask), one for the frontend (Vite).

> **No Docker or SAM required for local development.** The backend runs as a plain Python Flask server. SAM and Docker are only needed when deploying to AWS or testing Lambda-specific behaviour.

---

## Prerequisites

| Tool | Version | Install | Verify |
|------|---------|---------|--------|
| Python | 3.12+ | [python.org](https://www.python.org/downloads/) | `python --version` |
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) | `node --version` |
| Anthropic API key | — | [console.anthropic.com](https://console.anthropic.com/) | — |

---

## Step 1 — Configure environment

Create `env.json` in the project root. The backend server reads credentials from this file automatically.

```json
{
  "BootstrapFunction": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key-here"
  },
  "AgentFunction": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key-here",
    "ADZUNA_APP_ID": "your-app-id",
    "ADZUNA_APP_KEY": "your-app-key"
  }
}
```

> **Keep `env.json` out of source control.** It is already listed in `.gitignore`.

Create `frontend/.env.local`:

```
VITE_API_URL=
```

> Leave `VITE_API_URL` empty. The Vite dev server proxies `/bootstrap` and `/agent` to `localhost:3000` automatically — no value needed.

---

## Step 2 — Install backend dependencies

```powershell
pip install anthropic requests flask
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
Starting local dev server on http://localhost:3000
 * Running on http://127.0.0.1:3000
```

The server reads `env.json` on startup and hot-reloads when you edit files in `backend/src/`.

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

If port 3000 is in use, start the backend on a different port:

```powershell
$env:PORT=3001
python backend/server.py
```

Then update `vite.config.ts` to proxy to the new port:

```ts
proxy: {
  '/bootstrap': 'http://localhost:3001',
  '/agent': 'http://localhost:3001',
}
```

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'anthropic'` (or `flask`, `requests`)**

The Python packages aren't installed in your local environment. Run:

```powershell
pip install anthropic requests flask
```

---

**`Bootstrap failed` or request returns an error immediately**

Open browser DevTools → Network tab and check the `/bootstrap` request:

- `net::ERR_CONNECTION_REFUSED` → the backend isn't running. Start it with `python backend/server.py`.
- `500` response → check the backend terminal for the Python traceback.

---

**Browser console shows CORS error**

The Flask server handles CORS directly, so this should not occur. If it does, confirm `frontend/.env.local` has `VITE_API_URL=` (empty, not `http://localhost:3000`) and that the Vite dev server was restarted after the change.

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
sam deploy --guided   # first time — prompts for ANTHROPIC_API_KEY and other params
sam deploy            # subsequent deploys
```

After deploy, build the frontend with the API Gateway URL from SAM outputs:

```powershell
cd frontend
$env:VITE_API_URL="https://<api-id>.execute-api.<region>.amazonaws.com/Prod"
npm run build
```

Host `frontend/dist/` on S3 + CloudFront, Amplify, or Netlify.
