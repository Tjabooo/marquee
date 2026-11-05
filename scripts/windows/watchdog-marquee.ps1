# Starts the Marquee scheduled task whenever it isn't running. Windows can skip a boot trigger, and
# nothing else would bring Marquee back. install-service.ps1 registers this as the "Marquee Watchdog"
# task (SYSTEM, at startup and every 2 minutes). To keep Marquee stopped on purpose, create an empty
# file named .marquee-stopped in the Marquee folder.

$dir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (Test-Path (Join-Path $dir '.marquee-stopped')) { exit 0 }

$task = Get-ScheduledTask -TaskName 'Marquee' -ErrorAction SilentlyContinue
if (-not $task -or $task.State -in 'Running', 'Disabled') { exit 0 }

Start-ScheduledTask -TaskName 'Marquee'
$logs = Join-Path $dir 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory $logs | Out-Null }
Add-Content -Path (Join-Path $logs 'watchdog.log') -Value ("[{0:yyyy-MM-dd HH:mm:ss}] Marquee task was {1}, started it" -f (Get-Date), $task.State)
