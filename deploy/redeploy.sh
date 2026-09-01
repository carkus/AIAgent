#!/usr/bin/env bash
# Redeploy AIAgent to the carkus.com droplet after a code change.
#
# No git on the droplet (code was tar'd up, not cloned) and no CI — this
# script exists so "ship a change" is one command instead of re-deriving the
# tar/scp/restart dance from DEPLOY.md each time.
#
# Usage:
#   deploy/redeploy.sh backend    # sync backend/src + requirements, restart the service
#   deploy/redeploy.sh frontend   # npm run build locally, ship dist/, fix ownership
#   deploy/redeploy.sh all        # both
#
# Run from the repo root (paths below are relative to it).

set -euo pipefail

HOST="root@170.64.223.82"
REMOTE_BASE="/var/www/aiagent"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)

deploy_backend() {
    echo "==> Syncing backend/ ..."
    tar czf - --exclude='__pycache__' --exclude='*.pyc' -C backend . \
        | ssh "${SSH_OPTS[@]}" "$HOST" "sudo -u aiagent tar xzf - -C $REMOTE_BASE/src/backend"

    echo "==> Installing any new/changed Python deps ..."
    ssh "${SSH_OPTS[@]}" "$HOST" \
        "sudo -u aiagent $REMOTE_BASE/venv/bin/pip install -q -r $REMOTE_BASE/src/backend/requirements.txt"

    echo "==> Restarting aiagent service ..."
    ssh "${SSH_OPTS[@]}" "$HOST" "systemctl restart aiagent && sleep 1 && systemctl is-active aiagent"

    echo "==> Smoke check ..."
    ssh "${SSH_OPTS[@]}" "$HOST" "curl -s http://127.0.0.1:8787/models"
    echo
    echo "Backend redeployed."
}

deploy_frontend() {
    echo "==> Building frontend locally ..."
    (cd frontend && npm run build)

    echo "==> Shipping dist/ ..."
    tar czf - -C frontend/dist . \
        | ssh "${SSH_OPTS[@]}" "$HOST" "rm -rf /tmp/aiagent-dist && mkdir -p /tmp/aiagent-dist && tar xzf - -C /tmp/aiagent-dist"

    ssh "${SSH_OPTS[@]}" "$HOST" "
        sudo -u aiagent rm -rf $REMOTE_BASE/frontend/dist &&
        sudo -u aiagent mkdir -p $REMOTE_BASE/frontend/dist &&
        cp -r /tmp/aiagent-dist/* $REMOTE_BASE/frontend/dist/ &&
        chown -R aiagent:aiagent $REMOTE_BASE/frontend/dist &&
        rm -rf /tmp/aiagent-dist
    "
    echo "Frontend redeployed."
}

case "${1:-}" in
    backend)  deploy_backend ;;
    frontend) deploy_frontend ;;
    all)      deploy_backend; deploy_frontend ;;
    *)
        echo "Usage: $0 {backend|frontend|all}" >&2
        exit 1
        ;;
esac
