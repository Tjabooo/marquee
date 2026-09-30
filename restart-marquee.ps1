# Restarts the scheduled task created by setup-autostart.ps1 and reports status.
#   powershell -ExecutionPolicy Bypass -File .\restart-marquee.ps1

$dir = $PSScriptRoot

if (-not (Get-ScheduledTask -TaskName 'Marquee' -ErrorAction SilentlyContinue)) {
  Write-Host "No Marquee task found. Run setup-autostart.ps1 first." -ForegroundColor Red
  exit 1
}

Write-Host 'Stopping Marquee...'
Stop-ScheduledTask -TaskName 'Marquee' -ErrorAction SilentlyContinue
# Stopping the task can leave node.exe running.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Host 'Starting Marquee...'
Start-ScheduledTask -TaskName 'Marquee'

$port = 8080
$envFile = Join-Path $dir '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

$status = $null
for ($i = 0; $i -lt 20 -and -not $status; $i++) {
  Start-Sleep -Seconds 1
  try { $status = Invoke-RestMethod "http://127.0.0.1:$port/api/status" -TimeoutSec 2 } catch { }
}

function OnOff($v) { if ($v) { 'on' } else { 'off' } }

if ($status) {
  Write-Host "Marquee is running on port $port." -ForegroundColor Green
  Write-Host ("  Search: {0}   Library: {1}   Downloads: {2}   Torrents: {3}   Subtitles: {4}" -f `
    (OnOff $status.search), (OnOff $status.library), (OnOff $status.downloads), (OnOff $status.torrents), (OnOff $status.subtitles))
} else {
  Write-Host "Marquee didn't respond within 20 seconds. Last lines of the log:" -ForegroundColor Yellow
  Get-Content (Join-Path $dir 'logs\marquee.log') -Tail 15 -ErrorAction SilentlyContinue
}
