# Deploying AIAgent to the carkus.com droplet

Confirmed against the actual droplet (not assumed):

- Ubuntu 24.04, ~1GB RAM (hostname says "512mb" — it was resized after creation, DO doesn't rename the host), swap already partly in use with ~10 other services running.
- No Cloudflare Tunnel anywhere on the box. Cloudflare DNS is **DNS-only (grey cloud)** for carkus.com — traffic never touches Cloudflare's edge, so Cloudflare Access isn't usable here. Every existing site (`chattyprayers`, `jobfit.carkus.com`, etc.) is plain nginx + Certbot/Let's Encrypt, reachable directly on the droplet's public IP.
- Ollama already runs on the droplet (`127.0.0.1:11434`) as `ChattyPrayers.Api`'s fallback, sized to a tiny `qwen2.5:0.5b`. That confirms the ceiling, not a way around it: this app's bootstrap needs `qwen2.5-coder:7b`-class reliability (~4.7GB to load), which doesn't fit. **Production stays Gemini-only.**
- Convention on this box: apps live under `/var/www/<name>`, run via systemd, proxied by nginx, TLS via Certbot. This deployment follows that, with one deliberate deviation — a dedicated non-root `aiagent` system user, since nothing requires running as root and `chattyprayers.service` currently does only because no `User=` was set, not by design.

Frontend and backend are served from **one nginx server block, one domain** — no separate static host, no CORS dance, matching how the rest of this droplet works.

Privacy layer: **nginx HTTP Basic Auth**, not Cloudflare Access (unusable — see above) and not an API key baked into the React bundle (visible to anyone who opens dev tools). One shared login gates the whole app, frontend and API alike.

---

## 0. Pick a subdomain and add DNS

In the Cloudflare dashboard, add an **A record**, **DNS only** (grey cloud, matching every other record on this domain), for whatever subdomain you want — these steps assume `agent.carkus.com`. Point it at the droplet's existing public IP (same one every other `*.carkus.com` record uses).

## 1. Create the app user and directory

```bash
sudo useradd -r -m -d /var/www/aiagent -s /usr/sbin/nologin aiagent
sudo mkdir -p /var/www/aiagent
sudo chown aiagent:aiagent /var/www/aiagent
```

## 2. Get the code onto the droplet and install backend deps

```bash
sudo -u aiagent git clone <your-repo-url> /var/www/aiagent/src
# backend/ and frontend/ need to end up under /var/www/aiagent — either clone
# straight there, or symlink: adjust to taste, just keep paths below consistent.
sudo -u aiagent ln -s /var/www/aiagent/src/backend /var/www/aiagent/backend
sudo -u aiagent ln -s /var/www/aiagent/src/frontend /var/www/aiagent/frontend

cd /var/www/aiagent
sudo -u aiagent python3 -m venv /var/www/aiagent/venv
sudo -u aiagent /var/www/aiagent/venv/bin/pip install -r backend/requirements.txt
```

## 3. Secrets — `/var/www/aiagent/.env`

Create this as the `aiagent` user, mode 600 — **not** inline `Environment=` lines in the unit file (that's how `chattyprayers.service`'s key ended up printable via `systemctl cat`; don't repeat that here):

```bash
sudo -u aiagent tee /var/www/aiagent/.env > /dev/null <<'EOF'
GEMINI_API_KEY=<real key>
ADZUNA_APP_ID=<real id>
ADZUNA_APP_KEY=<real key>
RATE_LIMIT_PER_MINUTE=5
RATE_LIMIT_PER_DAY=50
EOF
sudo chmod 600 /var/www/aiagent/.env
```

## 4. systemd service

```bash
sudo cp /var/www/aiagent/src/deploy/aiagent.service /etc/systemd/system/aiagent.service
sudo systemctl daemon-reload
sudo systemctl enable --now aiagent
sudo systemctl status aiagent
curl -s http://127.0.0.1:8787/models   # expect {"models": []} — no Ollama configured for this app on this box
```

Keep `--workers 1` in the unit — `rate_limit.py`'s counters are process-local; more worker *processes* would each get their own counters and silently multiply the effective rate limit. `--threads 4` gives real concurrency for the streaming `/agent` endpoint without that problem.

## 5. Frontend build

Build **locally** (or in CI) and copy the `dist/` output up — no Node needed on the droplet:

```bash
cd frontend
npm install
npm run build          # leave VITE_API_URL unset — frontend and backend share an origin in prod, so relative paths (/bootstrap, /agent, ...) are correct
scp -r dist/* youruser@droplet:/tmp/aiagent-dist/
```

```bash
# on the droplet:
sudo -u aiagent rm -rf /var/www/aiagent/frontend/dist
sudo -u aiagent mkdir -p /var/www/aiagent/frontend/dist
sudo mv /tmp/aiagent-dist/* /var/www/aiagent/frontend/dist/
sudo chown -R aiagent:aiagent /var/www/aiagent/frontend/dist
```

## 6. nginx + Basic Auth + Certbot

```bash
sudo cp /var/www/aiagent/src/deploy/nginx-aiagent.conf /etc/nginx/sites-available/aiagent
# edit server_name in that file if you didn't use agent.carkus.com
sudo ln -s /etc/nginx/sites-available/aiagent /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Basic Auth — pick your own username; you'll be prompted for a password
sudo apt-get install -y apache2-utils   # provides htpasswd, if not already present
sudo htpasswd -c /etc/nginx/.htpasswd-aiagent <username>

sudo certbot --nginx -d agent.carkus.com
```

Certbot rewrites `/etc/nginx/sites-available/aiagent` in place to add the `listen 443 ssl` block and the `:80 -> :443` redirect, same as it did for `chattyprayers`.

Verify from your own machine: `https://agent.carkus.com` should prompt for the Basic Auth login before showing anything.

## 7. Watch memory after first real use

This box is already tight (~119MB free, some swap in use, ~10 other services). Right after deploying, and again after a real bootstrap+chat session, check:

```bash
free -h
sudo systemctl status aiagent   # confirm it hasn't been OOM-killed
```

If it gets tight, the cheapest lever is capping `--threads` down from 4, since each thread holds its own in-flight request state during a long agent loop.

---

## Redeploying after a code change

Steps 2–5 above, scripted: `deploy/redeploy.sh {backend|frontend|all}`, run
from the repo root on your machine. There's no git on the droplet and no
CI — this script is the redeploy path, doing the same tar/ssh/restart dance
as the initial deploy so you don't have to re-derive it by hand each time.

## Rotate the leaked ChattyPrayers key

Unrelated to this deployment, but found while gathering the info above:
`chattyprayers.service`'s `Environment=Gemini__ApiKey=...` line means that key
is printed in full by `systemctl cat chattyprayers` — readable by anyone with
shell access to the box, and it ended up pasted into a chat transcript while
debugging this. Worth rotating in Google AI Studio and switching that service
to an `EnvironmentFile` too, independent of this task.

## What's intentionally out of scope

- The AWS SAM/Lambda path (`template.yaml`) is left as-is for `sam local` dev — not deleted, not deployed here.
- `backend/src/agent.py` (`run_agent`) is dead code, unused by any deployed path — `agent_stream.py`'s `run_agent_stream` is what runs in production and what got the 25-round tool-call cap.
