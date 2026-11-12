# Registers Lilin with Task Scheduler so it starts at boot, before anyone signs in.
# Run from an elevated PowerShell (setup.js runs it for you when you choose autostart):
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1            # install or update
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -Uninstall
#
# One task, "Lilin", runs start-lilin.cmd as your account with normal (not elevated) rights; its
# password is needed to run before sign-in. Besides the boot trigger it has a trigger every 2 minutes
# that starts it again if it isn't running (Windows occasionally skips a boot trigger); a running
# Lilin is left alone. Create .lilin-stopped in the Lilin folder to keep it stopped on purpose.
#
# Nothing runs as SYSTEM or elevated. Older versions registered a "Lilin Watchdog" task that ran a
# script from this folder as SYSTEM; re-running this removes it. The Lilin folder is also checked:
# if every user of the PC may change its files, write access is limited to you, SYSTEM and
# administrators (others keep read access), so no one else can change what your task runs.
param(
  [switch]$Status,
  [switch]$Uninstall,
  [switch]$NoWatchdog,      # no 2-minute restart trigger, only the boot trigger
  [switch]$KeepFolderAcl,   # don't limit write access to the Lilin folder
  [switch]$NoStart,
  [string]$CredentialFile   # internal (setup wizard): your Windows password, DPAPI-encrypted for you; deleted once read
)

$ErrorActionPreference = 'Stop'
$dir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tasks = 'Lilin', 'Lilin Watchdog'   # the second is from older versions: removed on install

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
  Write-Host 'Lilin itself, its settings and its data were not touched.'
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js isn't on PATH. Install Node.js 22 LTS or later and reopen PowerShell."
}
if (-not (Test-Path (Join-Path $dir '.env'))) {
  Write-Warning "No .env in $dir. Run 'node setup.js' first."
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$cred = $null
if ($CredentialFile) {
  try {
    $secure = Get-Content -LiteralPath $CredentialFile -Raw | ConvertTo-SecureString
    $cred = New-Object Management.Automation.PSCredential($user, $secure)
  } catch { Write-Warning "Couldn't read the password from the setup wizard ($($_.Exception.Message)); asking instead." }
  finally { Remove-Item -LiteralPath $CredentialFile -Force -ErrorAction SilentlyContinue }
}
if (-not $cred) { $cred = Get-Credential -UserName $user -Message ("Windows password for $user (for a Microsoft account, the account " +
  'password, not the PIN). Task Scheduler needs it to start Lilin before anyone signs in.') }

# Limit who can change the files the task runs. New folders under C:\ let every signed-in user
# modify files in them (Authenticated Users: Modify), which would let another account on this PC
# change start-lilin.cmd or server.js and run code as you.
$broad = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4')   # Everyone, Authenticated Users, Users, INTERACTIVE
$writeBits = [int]([Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership')
function Get-BroadWriters([string]$path) {
  @((Get-Acl $path).Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band $writeBits) -and
    $(try { $broad -contains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $false })
  })
}
$writers = Get-BroadWriters $dir
if ($writers.Count -and -not $KeepFolderAcl) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $dir /inheritance:d /Q | Out-Null
  & icacls.exe $dir /remove:g '*S-1-1-0' '*S-1-5-11' '*S-1-5-32-545' '*S-1-5-4' /Q | Out-Null
  & icacls.exe $dir /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
  if ((Get-BroadWriters $dir).Count) { Write-Warning "Couldn't limit write access to $dir. Check its Security tab." }
  else { Write-Host "Limited write access to $dir to you, SYSTEM and administrators (others can read)." }
} elseif ($writers.Count) {
  Write-Warning "Every user of this PC can change files in $dir (-KeepFolderAcl). Anyone signed in to it could run code as you."
}

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $dir 'start-lilin.cmd') + '"') -WorkingDirectory $dir
$boot     = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT30S'   # let the network and mapped drives come up
$triggers = @($boot)
if (-not $NoWatchdog) {
  # Starts the task if it isn't running; MultipleInstances IgnoreNew leaves a running Lilin alone.
  $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 2)
}
# Priority 4 = normal. Task Scheduler's default (7) starts the server below normal with low I/O and
# memory priority, so its stream reads would wait behind downloads and other programs.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Priority 4
Register-ScheduledTask -TaskName 'Lilin' -Description 'Lilin media server' `
  -Action $action -Trigger $triggers -Settings $settings `
  -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
Write-Host ('Registered task Lilin' + $(if ($NoWatchdog) { '.' } else { ' (restarts within 2 minutes if it stops; create .lilin-stopped to keep it stopped).' }))

# Older versions: a SYSTEM task running a script from this folder. Never leave it behind.
if (Get-ScheduledTask -TaskName 'Lilin Watchdog' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'Lilin Watchdog' -Confirm:$false
  Write-Host 'Removed the old Lilin Watchdog task (it ran as SYSTEM; the Lilin task now restarts itself).'
}

if (-not $NoStart) {
  # Stop an instance started by hand so the port is free.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName 'Lilin'
  Write-Host "Lilin is starting. Log: $dir\logs\lilin.log" -ForegroundColor Green
}

# The task runs with a minimal PATH; tools it can't find can be set by full path in .env.
foreach ($tool in 'ffmpeg', 'ffprobe', 'atvscript') {
  $found = Get-Command $tool -ErrorAction SilentlyContinue
  if ($found) { Write-Host "  $tool -> $($found.Source)" }
  else { Write-Host "  $tool not found on PATH (set FFMPEG, FFPROBE or ATVSCRIPT in .env if you use it)" -ForegroundColor Yellow }
}
