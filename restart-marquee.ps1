# Restarts the scheduled task created by setup-autostart.ps1 and reports status.
#   powershell -ExecutionPolicy Bypass -File .\restart-marquee.ps1

$dir = $PSScriptRoot

if (-not (Get-ScheduledTask -TaskName 'Marquee' -ErrorAction SilentlyContinue)) {
  Write-Host "No Marquee task found. Run setup-autostart.ps1 first." -ForegroundColor Red
  exit 1
}

Write-Host 'Stopping Marquee...'
# Find Marquee and everything it started (ffmpeg conversions, Apple TV helpers) before stopping it,
# so no conversion is left running on its own. Downloads are unaffected: qBittorrent keeps going.
$all = @(Get-CimInstance Win32_Process)
$nodes = @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\.js' })
function Get-Descendants($parentId) {
  foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $parentId })) { $c; Get-Descendants $c.ProcessId }
}
$helpers = @(foreach ($n in $nodes) { Get-Descendants $n.ProcessId })

Stop-ScheduledTask -TaskName 'Marquee' -ErrorAction SilentlyContinue
# Stopping the task can leave node.exe and its helpers running.
foreach ($p in $nodes + $helpers) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
# Conversions orphaned by an earlier restart (they write *.marquee-tmp files).
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" |
  Where-Object { $_.CommandLine -match 'marquee-tmp' } |
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
