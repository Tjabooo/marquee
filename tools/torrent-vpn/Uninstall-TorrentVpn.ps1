<#
.SYNOPSIS
  Removes the torrent VPN tunnel and watchdog.
  By default qBittorrent stays fenced in (firewall rules + binding kept), so it can't fall back to
  the home connection. -AllowDirect also removes the firewall rules and unbinds qBittorrent.
#>
param([switch]$AllowDirect)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TorrentVpn.psm1') -Force
Assert-TvAdmin
$cfg = Read-TvConfig
Unregister-ScheduledTask -TaskName 'TorrentVpn Watchdog' -Confirm:$false -ErrorAction SilentlyContinue
if ($cfg -and (Get-Service (Get-TvServiceName $cfg.name) -ErrorAction SilentlyContinue)) {
  & (Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe') /uninstalltunnelservice $cfg.name
}
if ($AllowDirect) {
  Get-NetFirewallRule -DisplayName 'TorrentVpn: block qBittorrent outside tunnel*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if ($cfg) {
    $q = Connect-TvQbit $cfg
    Invoke-TvQbit $q '/api/v2/app/setPreferences' @{ json = '{"current_network_interface":"","current_interface_address":""}' } | Out-Null
  }
  Remove-Item -Recurse -Force (Get-TvDataDir) -ErrorAction SilentlyContinue
  Write-Host 'Removed. qBittorrent uses the normal connection again (home IP visible to peers).'
} else {
  Write-Host 'Tunnel and watchdog removed. qBittorrent is still fenced in: no torrent traffic until you reinstall, or run with -AllowDirect.'
}
