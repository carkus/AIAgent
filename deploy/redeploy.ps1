<#
.SYNOPSIS
  Redeploy AIAgent to the carkus.com droplet after a code change.
  PowerShell equivalent of redeploy.sh — use this one from PowerShell so
  Windows doesn't try to "open" the .sh file with a program picker.

.USAGE
  .\deploy\redeploy.ps1              # deploys both (default)
  .\deploy\redeploy.ps1 backend      # sync backend/src + requirements, restart the service
  .\deploy\redeploy.ps1 frontend     # npm run build locally, ship dist/, fix ownership
  .\deploy\redeploy.ps1 all

  Run from the repo root. Needs ssh/scp (Windows' built-in OpenSSH client)
  and tar (built into Windows 10/11) on PATH, plus SSH access to the droplet.
#>

param(
    [ValidateSet("backend", "frontend", "all")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"

$RemoteHost = "root@170.64.223.82"
$RemoteBase = "/var/www/aiagent"
$SshOpts = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new")
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Deploy-Backend {
    Write-Host "==> Packing backend/ ..."
    $tmpTar = Join-Path $env:TEMP "aiagent-backend.tar.gz"
    if (Test-Path $tmpTar) { Remove-Item $tmpTar -Force }
    Push-Location (Join-Path $RepoRoot "backend")
    try {
        tar czf $tmpTar --exclude=__pycache__ --exclude=*.pyc .
        if ($LASTEXITCODE -ne 0) { throw "tar failed" }
    } finally {
        Pop-Location
    }

    Write-Host "==> Shipping to droplet ..."
    scp @SshOpts $tmpTar "${RemoteHost}:/tmp/aiagent-backend.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "scp failed" }
    Remove-Item $tmpTar -Force

    Write-Host "==> Extracting on droplet ..."
    ssh @SshOpts $RemoteHost "sudo -u aiagent tar xzf /tmp/aiagent-backend.tar.gz -C $RemoteBase/src/backend && rm -f /tmp/aiagent-backend.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "remote extract failed" }

    Write-Host "==> Installing any new/changed Python deps ..."
    ssh @SshOpts $RemoteHost "sudo -u aiagent $RemoteBase/venv/bin/pip install -q -r $RemoteBase/src/backend/requirements.txt"

    Write-Host "==> Restarting aiagent service ..."
    ssh @SshOpts $RemoteHost "systemctl restart aiagent && sleep 1 && systemctl is-active aiagent"

    Write-Host "==> Smoke check ..."
    ssh @SshOpts $RemoteHost "curl -s http://127.0.0.1:8787/models"
    Write-Host ""
    Write-Host "Backend redeployed."
}

function Deploy-Frontend {
    Write-Host "==> Building frontend locally ..."
    Push-Location (Join-Path $RepoRoot "frontend")
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }

    Write-Host "==> Packing dist/ ..."
    $tmpTar = Join-Path $env:TEMP "aiagent-dist.tar.gz"
    if (Test-Path $tmpTar) { Remove-Item $tmpTar -Force }
    Push-Location (Join-Path $RepoRoot "frontend/dist")
    try {
        tar czf $tmpTar .
        if ($LASTEXITCODE -ne 0) { throw "tar failed" }
    } finally {
        Pop-Location
    }

    Write-Host "==> Shipping dist/ ..."
    scp @SshOpts $tmpTar "${RemoteHost}:/tmp/aiagent-dist.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "scp failed" }
    Remove-Item $tmpTar -Force

    Write-Host "==> Extracting and installing on droplet ..."
    $remoteCmd = @"
rm -rf /tmp/aiagent-dist && mkdir -p /tmp/aiagent-dist && tar xzf /tmp/aiagent-dist.tar.gz -C /tmp/aiagent-dist && rm -f /tmp/aiagent-dist.tar.gz &&
sudo -u aiagent rm -rf $RemoteBase/frontend/dist &&
sudo -u aiagent mkdir -p $RemoteBase/frontend/dist &&
cp -r /tmp/aiagent-dist/* $RemoteBase/frontend/dist/ &&
chown -R aiagent:aiagent $RemoteBase/frontend/dist &&
rm -rf /tmp/aiagent-dist
"@
    ssh @SshOpts $RemoteHost $remoteCmd
    if ($LASTEXITCODE -ne 0) { throw "remote frontend deploy failed" }
    Write-Host "Frontend redeployed."
}

switch ($Target) {
    "backend"  { Deploy-Backend }
    "frontend" { Deploy-Frontend }
    "all"      { Deploy-Backend; Deploy-Frontend }
}

Write-Host ""
Write-Host "Done."
