# Start ClipBox automatically (hidden) when you log in to Windows, and start it now.
# Usage: npm run autostart:install      Undo: npm run autostart:uninstall
$ErrorActionPreference = 'Stop'
$taskName = 'ClipBox'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'clipbox-hidden.vbs'
$root = (Resolve-Path (Join-Path $here '..\..')).Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not on PATH.' }
if (-not (Test-Path (Join-Path $root 'node_modules'))) { throw 'Run "npm install" first.' }

# Stop anything already running from this folder so the port is free.
& (Join-Path $here 'stop.ps1')

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Runs the ClipBox server from $root" -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$port = 3210
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/api/health"
    if ($r.StatusCode -eq 200) {
      Write-Output "ClipBox is running on port $port and will start automatically when you log in."
      Write-Output "Log: $root\data\clipbox.log"
      exit 0
    }
  } catch { }
}
Write-Output "Task registered, but the server didn't answer yet. Check $root\data\clipbox.log"
exit 1
