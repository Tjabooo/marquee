# Registers Marquee with Task Scheduler so it starts at boot, before anyone signs in.
# Run from an elevated PowerShell (setup.js runs it for you when you choose autostart):
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1            # install or update
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -Uninstall
#
# Two tasks are created. Re-running replaces them, so nothing is ever registered twice.
#   Marquee           runs start-marquee.cmd as your account (its password is needed to run before sign-in)
#   Marquee Watchdog  runs as SYSTEM every 2 minutes and starts "Marquee" if it isn't running, because
#                     Windows occasionally skips a boot trigger. Create .marquee-stopped in the Marquee
#                     folder to keep Marquee stopped on purpose.
param(
  [switch]$Status,
  [switch]$Uninstall,
  [switch]$NoWatchdog,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$dir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tasks = 'Marquee', 'Marquee Watchdog'

if ($Status) {
  foreach ($name in $tasks) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host "${name}: not installed"; continue }
    $info = Get-ScheduledTaskInfo -TaskName $name
    Write-Host ("{0}: {1}, last run {2} (result {3}), runs {4} {5}" -f $name, $t.State, $info.LastRunTime,
      $info.LastTaskResult, $t.Actions[0].Execute, $t.Actions[0].Arguments)
  }
  exit 0
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this from an elevated PowerShell (Run as administrator).' }

if ($Uninstall) {
  foreach ($name in $tasks) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "Removed task $name"
    }
  }
  Write-Host 'Marquee itself, its settings and its data were not touched.'
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js isn't on PATH. Install Node.js 22 LTS or later and reopen PowerShell."
}
if (-not (Test-Path (Join-Path $dir '.env'))) {
  Write-Warning "No .env in $dir. Run 'node setup.js' first."
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$cred = Get-Credential -UserName $user -Message ("Windows password for $user (for a Microsoft account, the account " +
  'password, not the PIN). Task Scheduler needs it to start Marquee before anyone signs in.')

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $dir 'start-marquee.cmd') + '"') -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'   # let the network and mapped drives come up
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Marquee' -Description 'Marquee media server' `
  -Action $action -Trigger $trigger -Settings $settings `
  -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
Write-Host 'Registered task Marquee.'

if (-not $NoWatchdog) {
  $wdAction   = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'watchdog-marquee.ps1') + '"')
  $wdBoot     = New-ScheduledTaskTrigger -AtStartup
  $wdBoot.Delay = 'PT2M'
  $wdRepeat   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2)
  $wdSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  $wdPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName 'Marquee Watchdog' -Description 'Starts the Marquee task if it is not running' `
    -Action $wdAction -Trigger $wdBoot, $wdRepeat -Settings $wdSettings -Principal $wdPrincipal -Force | Out-Null
  Write-Host 'Registered task Marquee Watchdog (create .marquee-stopped to keep Marquee stopped on purpose).'
}

if (-not $NoStart) {
  # Stop an instance started by hand so the port is free.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName 'Marquee'
  Write-Host "Marquee is starting. Log: $dir\logs\marquee.log" -ForegroundColor Green
}

# The task runs with a minimal PATH; tools it can't find can be set by full path in .env.
foreach ($tool in 'ffmpeg', 'ffprobe', 'atvscript') {
  $found = Get-Command $tool -ErrorAction SilentlyContinue
  if ($found) { Write-Host "  $tool -> $($found.Source)" }
  else { Write-Host "  $tool not found on PATH (set FFMPEG, FFPROBE or ATVSCRIPT in .env if you use it)" -ForegroundColor Yellow }
}
