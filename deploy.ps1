<#
.SYNOPSIS
  Redeploy AIAgent to the carkus.com droplet after a code change.
  Root-level entry point, matching the `.\deploy.ps1` convention used by the
  other projects in this workspace — forwards to deploy\redeploy.ps1, which
  holds the actual tar/scp/restart logic (shared with redeploy.sh for
  non-PowerShell shells).

.USAGE
  .\deploy.ps1              # deploys both (default)
  .\deploy.ps1 backend      # sync backend/src + requirements, restart the service
  .\deploy.ps1 frontend     # npm run build locally, ship dist/, fix ownership
  .\deploy.ps1 all

  Run from the repo root. Needs ssh/scp (Windows' built-in OpenSSH client)
  and tar (built into Windows 10/11) on PATH, plus SSH access to the droplet.
#>

param(
    [ValidateSet("backend", "frontend", "all")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "deploy\redeploy.ps1") -Target $Target
exit $LASTEXITCODE
