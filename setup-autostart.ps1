# Registers Marquee as a scheduled task that starts at boot, before any user logs in.
# Run from the project folder in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\setup-autostart.ps1
# To remove:
#   Unregister-ScheduledTask -TaskName Marquee -Confirm:$false

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js isn't on PATH. Install it from nodejs.org and reopen PowerShell."
}
if (-not (Test-Path (Join-Path $dir '.env'))) {
  Write-Warning "No .env file found in $dir. Create one from .env.example first."
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$cred = Get-Credential -UserName $user -Message ("Windows password for this account (for a Microsoft account, " +
  "the account password, not the PIN). Required to run the task before sign-in.")

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $dir 'start-marquee.cmd') + '"') -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'   # allow the network to come up
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'Marquee' -Description 'Marquee media server' `
  -Action $action -Trigger $trigger -Settings $settings `
  -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null

# Stop any instance already running so the port is free.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-ScheduledTask -TaskName 'Marquee'
Write-Host "Marquee is registered and starting. Log: $dir\logs\marquee.log" -ForegroundColor Green

# The task runs with a minimal PATH; missing tools can be set by full path in .env.
foreach ($tool in 'ffmpeg', 'ffprobe', 'atvscript') {
  $found = Get-Command $tool -ErrorAction SilentlyContinue
  if ($found) { Write-Host "  $tool -> $($found.Source)" }
  else { Write-Host "  $tool not found on PATH" -ForegroundColor Yellow }
}
