# Thin forwarder so `killrun.ps1` also works from inside frontend/ — the
# real script (and its port numbers) lives at the project root; keep that as
# the single source of truth rather than duplicating it here.
& (Join-Path $PSScriptRoot "..\killrun.ps1")
