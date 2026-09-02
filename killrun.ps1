# Kills whatever is squatting on AIAgent's backend + frontend ports, then
# starts both. Backend port is set by backend/server.py's PORT env var
# (default 4891); frontend port is set by frontend/vite.config.ts's
# server.port (strictPort: true there, so keep this in sync with it).
$backendPort = 4891
$frontendPort = 5273

function Kill-Port($port) {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $id = $conn.OwningProcess
        if ($id -gt 0) {
            $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "Killing $($proc.Name) (PID $id) on port $port"
                Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

Kill-Port $backendPort
Kill-Port $frontendPort

# Wait for both ports to actually free up before relaunching.
$deadline = [DateTime]::Now.AddSeconds(10)
while ([DateTime]::Now -lt $deadline) {
    $busy = (Get-NetTCPConnection -LocalPort $backendPort -ErrorAction SilentlyContinue) -or
            (Get-NetTCPConnection -LocalPort $frontendPort -ErrorAction SilentlyContinue)
    if (-not $busy) { break }
    Start-Sleep -Milliseconds 300
}

Write-Host "Starting backend (Flask) on port $backendPort in a new window..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot'; python backend/server.py"

Write-Host "Starting frontend (Vite) on port $frontendPort..."
Set-Location (Join-Path $PSScriptRoot "frontend")
npm run dev
