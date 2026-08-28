$ErrorActionPreference = "Stop"
$dashboardRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $dashboardRoot "backend"
if (-not (Test-Path (Join-Path $backendRoot ".venv\Scripts\python.exe"))) {
    Write-Host "未找到 backend/.venv。先执行：python -m venv backend/.venv; backend/.venv/Scripts/python -m pip install -r backend/requirements.txt"
    exit 1
}
$env:PYTHONPATH = $backendRoot
Push-Location $backendRoot
try {
    & (Join-Path $backendRoot ".venv\Scripts\python.exe") -m uvicorn app.main:app --host 127.0.0.1 --port 8787
} finally {
    Pop-Location
}
