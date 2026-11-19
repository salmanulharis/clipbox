# Stop ClipBox processes started from this folder (the restart loop and the server).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$server = Join-Path $root 'server\index.js'
$runner = Join-Path $here 'clipbox-run.cmd'

$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine.Contains($runner) -or $_.CommandLine.Contains($server))
}
# Stop the restart loop first so it doesn't start the server again.
foreach ($p in ($procs | Sort-Object { if ($_.Name -eq 'cmd.exe') { 0 } else { 1 } })) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Output "stopped $($p.Name) $($p.ProcessId)" } catch { }
}
