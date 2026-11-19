# Stop ClipBox and remove it from Windows startup.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Get-ScheduledTask -TaskName 'ClipBox' -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName 'ClipBox' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'ClipBox' -Confirm:$false
  Write-Output 'Removed the ClipBox startup task.'
} else {
  Write-Output 'No ClipBox startup task was registered.'
}
& (Join-Path $here 'stop.ps1')
