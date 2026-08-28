$ErrorActionPreference = "Stop"
$dashboardRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start.ps1"
$action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
Register-ScheduledTask -TaskName "WolfDashboard" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Write-Host "已注册登录后启动任务 WolfDashboard，服务地址：http://127.0.0.1:8787"
