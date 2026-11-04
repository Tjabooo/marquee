<#
.SYNOPSIS
  Puts qBittorrent (and only qBittorrent) behind a WireGuard VPN, fail closed.

.DESCRIPTION
  -Config takes one or more provider WireGuard .conf files, a folder of them or a .zip (for example
  Mullvad's "all servers" download). They must share one key and address. The first one is used;
  the rest are fallbacks the watchdog rotates to when a server stops answering.

  What it sets up:
    * WireGuard tunnel service <Name> with Table = off: it adds no routes, so the rest of the
      machine keeps its normal connection. A high-metric default route on the tunnel lets sockets
      bound to the tunnel address leave through it.
    * qBittorrent bound to the tunnel interface + address, UPnP off.
    * Firewall block rules for qbittorrent.exe on every local address except the tunnel's.
    * Scheduled task "TorrentVpn Watchdog" (SYSTEM, every minute + at startup).
  Run as Administrator. Needs WireGuard for Windows (winget install WireGuard.WireGuard).

.EXAMPLE
  .\Install-TorrentVpn.ps1 -Config C:\Users\me\Downloads\mullvad_wireguard_windows_all.zip -Prefer 'se-'
#>
param(
  [Parameter(Mandatory)][string[]]$Config,
  [string]$Name = 'torrent-vpn',
  [string]$Prefer = '',
  [string]$EnvFile = '',
  [string]$QbitUrl = '',
  [string]$QbitExe = (Join-Path $env:ProgramFiles 'qBittorrent\qbittorrent.exe'),
  [string]$CheckUrl = 'https://am.i.mullvad.net/json',
  [int]$Metric = 5000,
  [switch]$NoQbitRestart
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $EnvFile) { $EnvFile = Join-Path (Split-Path (Split-Path $here)) '.env' }   # the Marquee checkout's .env
Import-Module (Join-Path $here 'TorrentVpn.psm1') -Force
Assert-TvAdmin
if ($Name -notmatch '^[A-Za-z0-9_=+.-]{1,32}$') { throw 'Tunnel name: up to 32 letters, digits or _=+.-' }
$wireguard = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
if (-not (Test-Path $wireguard)) { throw 'WireGuard for Windows is not installed (winget install WireGuard.WireGuard).' }
if (-not (Test-Path $QbitExe)) { throw "qBittorrent not found at $QbitExe" }
if (-not (Test-Path $EnvFile)) { throw "Env file with QBIT_URL/QBIT_USER/QBIT_PASS not found: $EnvFile" }

# ---- collect configs ----
$data = Get-TvDataDir
New-Item -ItemType Directory -Force $data | Out-Null
Protect-TvPath $data
$files = @()
foreach ($c in $Config) {
  $item = Get-Item $c
  if ($item.PSIsContainer) { $files += Get-ChildItem $item.FullName -Filter *.conf -Recurse | Sort-Object Name }
  elseif ($item.Extension -eq '.zip') {
    $unzip = Join-Path $data 'import'; Remove-Item -Recurse -Force $unzip -ErrorAction SilentlyContinue
    Expand-Archive -Path $item.FullName -DestinationPath $unzip
    $files += Get-ChildItem $unzip -Filter *.conf -Recurse | Sort-Object Name
  } else { $files += $item }
}
if (-not $files.Count) { throw 'No .conf files found.' }
if ($Prefer) { $files = @($files | Where-Object { $_.Name -match $Prefer }) + @($files | Where-Object { $_.Name -notmatch $Prefer }) }

$parsed = @($files | ForEach-Object { $p = ConvertFrom-TvWireGuardConfig (Get-Content -Raw $_.FullName); $p | Add-Member -NotePropertyName File -NotePropertyValue $_.BaseName; $p })
$first = $parsed[0]
$mismatch = @($parsed | Where-Object { $_.PrivateKey -ne $first.PrivateKey -or $_.Address -ne $first.Address })
if ($mismatch.Count) { throw "These configs use a different key or address than $($first.File): $(($mismatch.File) -join ', ')" }
$peers = @($parsed | ForEach-Object { [pscustomobject]@{ name = $_.File; publicKey = $_.PublicKey; endpoint = $_.Endpoint; presharedKey = $_.PresharedKey } })
Remove-Item -Recurse -Force (Join-Path $data 'import') -ErrorAction SilentlyContinue

$cfg = [pscustomobject]@{
  name = $Name; address = $first.Address; metric = $Metric
  envFile = (Resolve-Path $EnvFile).Path; qbitUrl = $QbitUrl; qbitExe = (Resolve-Path $QbitExe).Path; checkUrl = $CheckUrl
  interface = [pscustomobject]@{ PrivateKey = $first.PrivateKey; Address = $first.Address; Mtu = $first.Mtu; PublicKey = $null; Endpoint = $null; PresharedKey = $null }
  peers = $peers; peerIndex = 0; qbitInterface = $null
}
Save-TvJson $cfg (Join-Path $data 'config.json')
Remove-Item (Join-Path $data 'state.json') -ErrorAction SilentlyContinue
Write-Host "Tunnel address $($cfg.address); $($peers.Count) server(s), starting with $($peers[0].name)"

# ---- firewall first, so qBittorrent is fenced in before anything else changes ----
Set-TvFirewall $cfg

# ---- tunnel ----
$confPath = Join-Path $data "$Name.conf"
Set-Content -Encoding ascii -Path $confPath -Value (New-TvTunnelConfig $cfg.interface $peers[0])
if (Get-Service (Get-TvServiceName $Name) -ErrorAction SilentlyContinue) {
  & $wireguard /uninstalltunnelservice $Name; Start-Sleep 3
}
& $wireguard /installtunnelservice $confPath
$deadline = (Get-Date).AddSeconds(30)
while (-not (Get-NetAdapter -Name $Name -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up')) {
  if ((Get-Date) -gt $deadline) { throw 'The tunnel adapter did not come up.' }
  Start-Sleep 1
}
Set-TvRoute $cfg | Out-Null

# ---- qBittorrent ----
$q = Connect-TvQbit $cfg
$bind = Set-TvQbitBinding $cfg $q
$cfg.qbitInterface = $bind.Interface
Save-TvJson $cfg (Join-Path $data 'config.json')
Write-Host "qBittorrent bound to $($bind.Interface) / $($cfg.address)"

# Restart qBittorrent so no peer connection opened before the switch survives it.
# It runs in the logged-in user's session, so it is relaunched through an interactive task.
if (-not $NoQbitRestart) {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cfg.qbitExe } | Select-Object -First 1
  if ($proc) {
    $owner = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" | Invoke-CimMethod -MethodName GetOwner)
    $user = "$($owner.Domain)\$($owner.User)"
    try { Invoke-TvQbit $q '/api/v2/app/shutdown' @{} | Out-Null } catch { }
    $proc.WaitForExit(30000) | Out-Null
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    $task = 'TorrentVpn qBittorrent relaunch'
    $action = New-ScheduledTaskAction -Execute $cfg.qbitExe
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
    Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $task
    $deadline = (Get-Date).AddSeconds(60)
    do { Start-Sleep 2; try { $q = Connect-TvQbit $cfg; $up = $true } catch { $up = $false } } until ($up -or (Get-Date) -gt $deadline)
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    if (-not $up) { Write-Warning 'qBittorrent did not come back within a minute; start it by hand.' } else { Write-Host 'qBittorrent restarted' }
  }
}

# ---- watchdog ----
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $here 'Watchdog.ps1')`" -Quiet"
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$boot = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'TorrentVpn Watchdog' -Action $action -Trigger @($every, $boot) -Settings $settings `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest) -Force | Out-Null
Write-TvLog "installed: $($peers.Count) server(s), address $($cfg.address)"

Start-Sleep 5
& (Join-Path $here 'Watchdog.ps1') -Quiet
& (Join-Path $here 'Test-TorrentVpn.ps1')
