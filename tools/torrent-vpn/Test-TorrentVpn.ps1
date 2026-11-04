<#
.SYNOPSIS
  Checks the torrent VPN end to end and prints PASS/FAIL per check.
  -Drill also pulls the tunnel down for a moment to prove the kill switch holds.
#>
param([switch]$Drill)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TorrentVpn.psm1') -Force
Assert-TvAdmin
$cfg = Read-TvConfig
if (-not $cfg) { throw 'Torrent VPN is not installed (no config.json).' }
$fails = 0
function Check([string]$What, [bool]$Ok, [string]$Detail = '') {
  $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
  if (-not $Ok) { $script:fails++ }
  Write-Host ("[{0}] {1}{2}" -f $mark, $What, $(if ($Detail) { " - $Detail" } else { '' }))
}

$svc = Get-Service (Get-TvServiceName $cfg.name) -ErrorAction SilentlyContinue
Check 'tunnel service running' ($svc -and $svc.Status -eq 'Running') $cfg.peers[[int]$cfg.peerIndex].name
$age = Get-TvHandshakeAge $cfg.name
Check 'recent handshake' ($null -ne $age -and $age -lt 180) "$age s ago"
Check 'tunnel default route present' ([bool](Get-NetRoute -InterfaceAlias $cfg.name -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue))
$best = (Find-NetRoute -RemoteIPAddress 1.1.1.1 | Where-Object InterfaceAlias | Select-Object -First 1).InterfaceAlias
Check 'rest of the machine stays off the tunnel' ($best -ne $cfg.name) "default traffic uses $best"
$rules = @(Get-NetFirewallRule -DisplayName 'TorrentVpn: block qBittorrent outside tunnel*' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' })
Check 'firewall kill switch (in + out)' ($rules.Count -eq 2)

$q = Connect-TvQbit $cfg
$prefs = Invoke-TvQbit $q '/api/v2/app/preferences'
$wantIface = Get-TvQbitInterfaceValue $q $cfg.name
Check 'qBittorrent bound to the tunnel interface' ($prefs.current_network_interface -and $prefs.current_network_interface -eq $wantIface) $prefs.current_network_interface
Check 'qBittorrent bound to the tunnel address' ($prefs.current_interface_address -eq $cfg.address) $prefs.current_interface_address
Check 'qBittorrent UPnP off' (-not $prefs.upnp)
$sock = Get-TvQbitSockets $cfg
Check 'no qBittorrent connections outside the tunnel' ($sock.Leaks.Count -eq 0) ($sock.Leaks -join '; ')
Check 'no qBittorrent listeners outside the tunnel' ($sock.Strays.Count -eq 0) ($sock.Strays -join '; ')

$homeIp = Get-TvHomeIp
$exit = Test-TvExit $cfg
Check 'tunnel exit answers' $exit.ok "$($exit.ip) $($exit.city) $($exit.country) $($exit.server)"
if ($null -ne $exit.provider) { Check 'provider confirms its exit IP' $exit.provider }
Check 'exit IP is not the home IP' ($exit.ok -and $homeIp -and $exit.ip -ne $homeIp) "home $homeIp"
$info = Invoke-TvQbit $q '/api/v2/transfer/info'
$ext = $info.last_external_address_v4
Check 'qBittorrent public address (as peers see it) is not home' ($ext -ne $homeIp) $(if ($ext) { $ext } else { 'not learned yet' })

if ($Drill) {
  Write-Host '--- drill: stopping the tunnel for 20 s'
  Stop-Service (Get-TvServiceName $cfg.name) -Force
  Start-Sleep 20
  $out = & curl.exe -s -m 6 --interface $cfg.address -o NUL -w '%{http_code}' https://1.1.1.1 2>$null
  Check 'drill: nothing gets out on the tunnel address' ($out -eq '000' -or -not $out) "http $out"
  $sock = Get-TvQbitSockets $cfg
  Check 'drill: qBittorrent has no connections outside the tunnel' ($sock.Leaks.Count -eq 0) ($sock.Leaks -join '; ')
  $before = (Invoke-TvQbit $q '/api/v2/transfer/info')
  Start-Sleep 10
  $after = (Invoke-TvQbit $q '/api/v2/transfer/info')
  $moved = ($after.dl_info_data - $before.dl_info_data) + ($after.up_info_data - $before.up_info_data)
  Check 'drill: qBittorrent moves no data while the tunnel is down' ($moved -le 0) "$moved bytes in 10 s"
  Start-Service (Get-TvServiceName $cfg.name)
  Start-Sleep 5; Set-TvRoute $cfg | Out-Null
  Write-Host '--- drill: tunnel back up'
}
if ($fails) { Write-Host "$fails check(s) failed" } else { Write-Host 'All checks passed' }
