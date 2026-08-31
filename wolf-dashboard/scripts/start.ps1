$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Import-ProviderEnvironment {
    param([Parameter(Mandatory = $true)][string[]]$Paths)

    $allowedKeys = @(
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "OPENAI_REASONING_EFFORT"
    )
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            continue
        }
        foreach ($raw in Get-Content -LiteralPath $path -Encoding UTF8) {
            $line = $raw.Trim()
            if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
                continue
            }
            $key, $value = $line.Split("=", 2)
            $key = $key.Trim()
            if ($allowedKeys -notcontains $key) {
                continue
            }
            if ($null -ne [Environment]::GetEnvironmentVariable($key, "Process")) {
                continue
            }
            $value = $value.Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Resolve-RequiredFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-RequiredDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Description was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-RequiredCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace($command.Source)) {
        throw "$Description was not found on PATH: $Name"
    }
    return (Resolve-Path -LiteralPath $command.Source).Path
}

function Stop-ManagedProcess {
    param([System.Diagnostics.Process]$Process, [string]$Name)

    if ($null -eq $Process) {
        return
    }
    try {
        if (-not $Process.HasExited) {
            Write-Host "Stopping $Name (PID $($Process.Id))..."
            $Process.Kill()
            $Process.WaitForExit(5000) | Out-Null
        }
    } catch [System.InvalidOperationException] {
        # The process exited between HasExited and Kill; cleanup is complete.
    } catch {
        Write-Warning "Could not stop $Name (PID $($Process.Id)): $($_.Exception.Message)"
    } finally {
        $Process.Dispose()
    }
}

$dashboardRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Import-ProviderEnvironment -Paths @(
    (Join-Path $dashboardRoot ".env"),
    (Join-Path (Split-Path $dashboardRoot) ".env")
)
$backendRoot = Resolve-RequiredFile -Path (Join-Path $dashboardRoot "backend\requirements.txt") -Description "Backend requirements file" | Split-Path
$sidecarRoot = (Resolve-Path -LiteralPath (Join-Path $dashboardRoot "agent-sidecar")).Path
$pythonPath = Resolve-RequiredFile -Path (Join-Path $backendRoot ".venv\Scripts\python.exe") -Description "Python virtual environment"
$sidecarPackage = Resolve-RequiredFile -Path (Join-Path $sidecarRoot "package.json") -Description "Sidecar package manifest"
$sidecarLock = Resolve-RequiredFile -Path (Join-Path $sidecarRoot "package-lock.json") -Description "Sidecar lockfile"
$sidecarModules = Resolve-RequiredDirectory -Path (Join-Path $sidecarRoot "node_modules") -Description "Sidecar dependencies (run npm ci)"
$null = Resolve-RequiredDirectory -Path (Join-Path $sidecarModules "@earendil-works\pi-agent-core") -Description "PI Agent core dependency"
$null = Resolve-RequiredDirectory -Path (Join-Path $sidecarModules "@earendil-works\pi-ai") -Description "PI AI dependency"
$sidecarEntry = Resolve-RequiredFile -Path (Join-Path $sidecarRoot "dist\main.js") -Description "Built sidecar entrypoint"
$nodePath = Resolve-RequiredCommand -Name "node.exe" -Description "Node.js 22 or newer"
$npmPath = Resolve-RequiredCommand -Name "npm.cmd" -Description "npm"

$pythonProbe = & $pythonPath -c "import fastapi, uvicorn" 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "FastAPI dependencies are not installed in the venv; run pip install -r backend\requirements.txt"
}

$nodeVersionText = (& $nodePath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<major>\d+)(?:\.\d+){0,2}') {
    throw "Could not determine the Node.js version from $nodePath"
}
if ([int]$Matches.major -lt 22) {
    throw "Node.js 22 or newer is required; found $nodeVersionText"
}
$null = & $npmPath --version
if ($LASTEXITCODE -ne 0) {
    throw "npm is not executable: $npmPath"
}

$env:PYTHONPATH = $backendRoot
$pythonProcess = $null
$sidecarProcess = $null
$script:cancelRequested = $false
$cancelHandler = [ConsoleCancelEventHandler]{
    param($sender, $eventArgs)
    $eventArgs.Cancel = $true
    $script:cancelRequested = $true
}
[Console]::add_CancelKeyPress($cancelHandler)
$exitCode = 0

try {
    Write-Host "Starting FastAPI on http://127.0.0.1:8787..."
    $pythonProcess = Start-Process -FilePath $pythonPath `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8787") `
        -WorkingDirectory $backendRoot -NoNewWindow -PassThru

    Write-Host "Starting PI Agent sidecar on http://127.0.0.1:8790..."
    $sidecarProcess = Start-Process -FilePath $nodePath `
        -ArgumentList @("`"$sidecarEntry`"") `
        -WorkingDirectory $sidecarRoot -NoNewWindow -PassThru

    while ($true) {
        if ($script:cancelRequested) {
            $exitCode = 130
            Write-Warning "Ctrl+C received; stopping WolfBot services."
            break
        }

        $pythonExited = $pythonProcess.HasExited
        $sidecarExited = $sidecarProcess.HasExited
        if ($pythonExited -or $sidecarExited) {
            $failedName = if ($pythonExited) { "FastAPI" } else { "PI Agent sidecar" }
            $failedProcess = if ($pythonExited) { $pythonProcess } else { $sidecarProcess }
            $observedCode = $failedProcess.ExitCode
            $exitCode = if ($observedCode -ne 0) { [int]$observedCode } else { 1 }
            Write-Warning "$failedName exited unexpectedly with code $observedCode; stopping the other service."
            break
        }
        Start-Sleep -Milliseconds 500
    }
} catch {
    $exitCode = 1
    Write-Warning $_
} finally {
    [Console]::remove_CancelKeyPress($cancelHandler)
    Stop-ManagedProcess -Process $sidecarProcess -Name "PI Agent sidecar"
    Stop-ManagedProcess -Process $pythonProcess -Name "FastAPI"
}

exit $exitCode
