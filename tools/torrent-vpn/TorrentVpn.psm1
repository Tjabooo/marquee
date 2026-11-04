# Shared functions for the torrent VPN split tunnel (Windows, WireGuard, qBittorrent).
# Only qBittorrent uses the tunnel; everything else keeps the normal connection.
# Fail closed: qBittorrent is bound to the tunnel interface + address, and a firewall rule blocks
# qbittorrent.exe on every local address except the tunnel's.

$Script:DataDir = Join-Path $env:ProgramData 'TorrentVpn'
$Script:ConfigFile = Join-Path $Script:DataDir 'config.json'
$Script:StatusFile = Join-Path $Script:DataDir 'status.json'
$Script:StateFile = Join-Path $Script:DataDir 'state.json'
$Script:LogFile = Join-Path $Script:DataDir 'watchdog.log'
$Script:WgDir = Join-Path $env:ProgramFiles 'WireGuard'
$Script:RulePrefix = 'TorrentVpn: block qBittorrent outside tunnel'

function Get-TvDataDir { $Script:DataDir }

function Write-TvLog([string]$Message) {
  New-Item -ItemType Directory -Force $Script:DataDir | Out-Null
  if ((Test-Path $Script:LogFile) -and (Get-Item $Script:LogFile).Length -gt 1MB) {
    Move-Item -Force $Script:LogFile "$($Script:LogFile).1"
  }
  Add-Content -Path $Script:LogFile -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Message)
}

function Assert-TvAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this as Administrator.' }
}

function Read-TvConfig {
  if (-not (Test-Path $Script:ConfigFile)) { return $null }
  Get-Content -Raw $Script:ConfigFile | ConvertFrom-Json
}

function Save-TvJson($Object, [string]$Path) {
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  $tmp = "$Path.tmp"
  $Object | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $tmp
  Move-Item -Force $tmp $Path
}

# The status (no secrets: tunnel/exit addresses, problems) in a folder every local user may read,
# because the data folder is SYSTEM + Administrators only and Marquee runs unelevated.
$Script:PublicDir = Join-Path $env:ProgramData 'TorrentVpn-Status'
function Publish-TvStatus($Status) {
  if (-not (Test-Path $Script:PublicDir)) {
    New-Item -ItemType Directory -Force $Script:PublicDir | Out-Null
    & icacls $Script:PublicDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-11:(OI)(CI)RX' | Out-Null
  }
  Save-TvJson $Status (Join-Path $Script:PublicDir 'status.json')
}

function Read-TvState {
  if (Test-Path $Script:StateFile) { try { return Get-Content -Raw $Script:StateFile | ConvertFrom-Json } catch { } }
  [pscustomobject]@{}
}

# Restrict a file or folder to SYSTEM + Administrators (the tunnel config holds the private key).
function Protect-TvPath([string]$Path) {
  & icacls $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
}

# ---------- WireGuard config ----------

# Parses a provider WireGuard config and returns the fields the split tunnel needs.
function ConvertFrom-TvWireGuardConfig([string]$Text) {
  $section = ''; $iface = @{}; $peers = @()
  $peer = $null
  foreach ($raw in ($Text -split "`r?`n")) {
    $line = ($raw -replace '#.*$', '').Trim()
    if (-not $line) { continue }
    if ($line -match '^\[(\w+)\]$') {
      $section = $matches[1].ToLower()
      if ($section -eq 'peer') { $peer = @{}; $peers += $peer }
      continue
    }
    if ($line -notmatch '^([^=]+?)\s*=\s*(.*)$') { continue }
    $key = $matches[1].Trim().ToLower(); $value = $matches[2].Trim()
    if ($section -eq 'interface') { $iface[$key] = $value } elseif ($section -eq 'peer' -and $peer) { $peer[$key] = $value }
  }
  if (-not $iface.privatekey) { throw 'The WireGuard config has no [Interface] PrivateKey.' }
  if ($peers.Count -ne 1) { throw "Expected exactly one [Peer] in the WireGuard config, found $($peers.Count)." }
  $p = $peers[0]
  if (-not $p.publickey -or -not $p.endpoint) { throw 'The [Peer] needs a PublicKey and an Endpoint.' }
  $v4 = @(($iface.address -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}(/\d+)?$' })
  if (-not $v4.Count) { throw 'The [Interface] Address has no IPv4 address.' }
  [pscustomobject]@{
    PrivateKey   = $iface.privatekey
    Address      = ($v4[0] -split '/')[0]
    Mtu          = $iface.mtu
    PublicKey    = $p.publickey
    PresharedKey = $p.presharedkey
    Endpoint     = $p.endpoint
  }
}

# The tunnel config WireGuard runs: no routes of its own (Table = off), no DNS, IPv4 only.
# AllowedIPs is two /1 halves, not 0.0.0.0/0: with /0 WireGuard for Windows turns on its own
# whole-machine kill switch, which would cut the server off from the LAN.
function New-TvTunnelConfig($Parsed, $Peer = $null) {
  if ($Peer) { $Parsed = $Parsed.PSObject.Copy(); $Parsed.PublicKey = $Peer.publicKey; $Parsed.Endpoint = $Peer.endpoint; $Parsed.PresharedKey = $Peer.presharedKey }
  $lines = @('[Interface]', "PrivateKey = $($Parsed.PrivateKey)", "Address = $($Parsed.Address)/32", 'Table = off')
  if ($Parsed.Mtu) { $lines += "MTU = $($Parsed.Mtu)" }
  $lines += @('', '[Peer]', "PublicKey = $($Parsed.PublicKey)")
  if ($Parsed.PresharedKey) { $lines += "PresharedKey = $($Parsed.PresharedKey)" }
  $lines += @("Endpoint = $($Parsed.Endpoint)", 'AllowedIPs = 0.0.0.0/1, 128.0.0.0/1', 'PersistentKeepalive = 25')
  ($lines -join "`r`n") + "`r`n"
}

function Get-TvServiceName([string]$Name) { "WireGuardTunnel`$$Name" }

function Get-TvHandshakeAge([string]$Name) {
  $out = & (Join-Path $Script:WgDir 'wg.exe') show $Name latest-handshakes 2>$null
  if (-not $out) { return $null }
  $epoch = [long](($out -split '\s+')[1])
  if ($epoch -le 0) { return $null }
  [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $epoch)
}

# ---------- routing ----------

# A default route on the tunnel with a high metric: normal traffic still prefers Ethernet, but a
# socket bound to the tunnel address (qBittorrent) can only leave through the tunnel, because
# Windows uses the strong host model (a source address is only sent out of its own interface).
function Set-TvRoute($Config) {
  $adapter = Get-NetAdapter -Name $Config.name -ErrorAction SilentlyContinue
  if (-not $adapter -or $adapter.Status -ne 'Up') { return $false }
  $ip = Get-NetIPInterface -InterfaceAlias $Config.name -AddressFamily IPv4 -ErrorAction SilentlyContinue
  if ($ip.InterfaceMetric -ne $Config.metric) { Set-NetIPInterface -InterfaceAlias $Config.name -AddressFamily IPv4 -InterfaceMetric $Config.metric }
  if ($ip.WeakHostSend -ne 'Disabled') { Set-NetIPInterface -InterfaceAlias $Config.name -AddressFamily IPv4 -WeakHostSend Disabled }
  $route = Get-NetRoute -InterfaceAlias $Config.name -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue
  if (-not $route) {
    New-NetRoute -InterfaceAlias $Config.name -DestinationPrefix '0.0.0.0/0' -NextHop '0.0.0.0' -RouteMetric $Config.metric -PolicyStore ActiveStore | Out-Null
    Write-TvLog 'route added on tunnel'
  }
  $true
}

# ---------- firewall ----------

function ConvertTo-TvUInt([string]$Ip) {
  $b = ([Net.IPAddress]::Parse($Ip)).GetAddressBytes(); [Array]::Reverse($b); [BitConverter]::ToUInt32($b, 0)
}
function ConvertFrom-TvUInt([uint32]$N) {
  $b = [BitConverter]::GetBytes($N); [Array]::Reverse($b); ([Net.IPAddress]$b).ToString()
}

# Every local address except the tunnel's and loopback, as firewall ranges.
function Get-TvBlockedLocalRanges([string]$TunnelIp) {
  $holes = @(
    @((ConvertTo-TvUInt '127.0.0.0'), (ConvertTo-TvUInt '127.255.255.255')),
    @((ConvertTo-TvUInt $TunnelIp), (ConvertTo-TvUInt $TunnelIp))
  ) | Sort-Object { $_[0] }
  $ranges = @(); [uint64]$start = 0
  foreach ($h in $holes) {
    if ([uint64]$h[0] -gt $start) { $ranges += '{0}-{1}' -f (ConvertFrom-TvUInt ([uint32]$start)), (ConvertFrom-TvUInt ([uint32]([uint64]$h[0] - 1))) }
    $start = [uint64]$h[1] + 1
  }
  if ($start -le [uint32]::MaxValue) { $ranges += '{0}-255.255.255.255' -f (ConvertFrom-TvUInt ([uint32]$start)) }
  $ranges + @('::-::0', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
}

function Set-TvFirewall($Config) {
  $ranges = Get-TvBlockedLocalRanges $Config.address
  $sig = "[sig $($Config.address) $($Config.qbitExe)]"
  foreach ($dir in 'Outbound', 'Inbound') {
    $name = "$($Script:RulePrefix) ($dir)"
    $existing = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
    $good = @($existing | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' -and "$($_.Description)".EndsWith($sig) })
    if ($good.Count -eq 1 -and $existing.Count -eq 1) { continue }
    # New rule first, then drop the old ones, so qBittorrent is never unfenced in between.
    $rule = New-NetFirewallRule -DisplayName $name -Direction $dir -Action Block -Program $Config.qbitExe -LocalAddress $ranges -Profile Any `
      -Description "Torrent VPN kill switch: qBittorrent may only use the tunnel address (and loopback for its WebUI). $sig"
    $existing | Where-Object { $_.Name -ne $rule.Name } | Remove-NetFirewallRule
    Write-TvLog "firewall rule ($dir) set"
  }
}

# ---------- qBittorrent ----------

function Get-TvQbitCredentials($Config) {
  $vals = @{}
  Get-Content $Config.envFile | Where-Object { $_ -match '^\s*(QBIT_URL|QBIT_USER|QBIT_PASS)\s*=\s*(.*)$' } | ForEach-Object {
    $vals[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
  }
  $url = if ($Config.qbitUrl) { $Config.qbitUrl } elseif ($vals.QBIT_URL) { $vals.QBIT_URL } else { 'http://127.0.0.1:8080' }
  [pscustomobject]@{ Url = $url.TrimEnd('/'); User = $vals.QBIT_USER; Pass = $vals.QBIT_PASS }
}

function Connect-TvQbit($Config) {
  $c = Get-TvQbitCredentials $Config
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $headers = @{ Referer = $c.Url }
  if ($c.User) {
    $r = Invoke-WebRequest -UseBasicParsing -WebSession $session -Method Post "$($c.Url)/api/v2/auth/login" `
      -Body @{ username = $c.User; password = $c.Pass } -Headers $headers -TimeoutSec 10
    if ($r.Content -match 'Fails') { throw 'qBittorrent rejected the login from the env file.' }
  }
  [pscustomobject]@{ Url = $c.Url; Session = $session; Headers = $headers }
}

function Invoke-TvQbit($Q, [string]$Path, $Form = $null) {
  if ($Form) {
    $r = Invoke-WebRequest -UseBasicParsing -WebSession $Q.Session -Method Post "$($Q.Url)$Path" -Body $Form -Headers $Q.Headers -TimeoutSec 15
  } else {
    $r = Invoke-WebRequest -UseBasicParsing -WebSession $Q.Session "$($Q.Url)$Path" -Headers $Q.Headers -TimeoutSec 15
  }
  $text = "$($r.Content)".Trim()
  if ($text.StartsWith('{') -or $text.StartsWith('[')) { return $text | ConvertFrom-Json }
  $text
}

function Get-TvQbitInterfaceValue($Q, [string]$Name) {
  $list = Invoke-TvQbit $Q '/api/v2/app/networkInterfaceList'
  ($list | Where-Object { $_.name -eq $Name } | Select-Object -First 1).value
}

# Binds qBittorrent to the tunnel interface and address and turns UPnP off (a UPnP mapping on the
# home router would point at the home IP). Returns what changed.
function Set-TvQbitBinding($Config, $Q) {
  $prefs = Invoke-TvQbit $Q '/api/v2/app/preferences'
  $want = @{}
  $iface = Get-TvQbitInterfaceValue $Q $Config.name
  if (-not $iface -and $Config.qbitInterface) { $iface = $Config.qbitInterface }   # tunnel down: keep the last known value
  if (-not $iface) { $iface = "missing-$($Config.name)" }                          # never fall back to "any interface"
  if ($prefs.current_network_interface -ne $iface) { $want.current_network_interface = $iface }
  if ($prefs.current_interface_address -ne $Config.address) { $want.current_interface_address = $Config.address }
  if ($prefs.upnp) { $want.upnp = $false }
  if ($prefs.lsd) { $want.lsd = $false }   # Local Peer Discovery multicasts on the LAN, outside the tunnel
  if ($want.Count) {
    Invoke-TvQbit $Q '/api/v2/app/setPreferences' @{ json = ($want | ConvertTo-Json -Compress) } | Out-Null
    Write-TvLog ("qBittorrent binding set: " + (($want.Keys | Sort-Object) -join ', '))
  }
  [pscustomobject]@{ Interface = $iface; Changed = @($want.Keys) }
}

# qBittorrent sockets that are NOT on the tunnel (loopback excepted).
# Leaks = connections actually open or opening on another address (the firewall should make these
# impossible). Strays = listening or UDP sockets on another address: blocked by the firewall, but
# reported so a config drift gets noticed. Unconnected "Bound" TCP sockets are neither.
function Get-TvQbitSockets($Config) {
  $result = [pscustomobject]@{ Leaks = @(); Strays = @() }
  $ids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Config.qbitExe } | ForEach-Object Id)
  if (-not $ids.Count) { return $result }
  $ok = { param($a) $a -eq $Config.address -or $a -like '127.*' -or $a -eq '::1' }
  $tcp = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and -not (& $ok $_.LocalAddress) })
  $result.Leaks = @($tcp | Where-Object { $_.State -notin 'Listen', 'Bound' -and $_.RemoteAddress -notlike '127.*' -and $_.RemoteAddress -ne '::1' -and $_.RemoteAddress -ne '0.0.0.0' } |
    ForEach-Object { "tcp $($_.State) $($_.LocalAddress):$($_.LocalPort) -> $($_.RemoteAddress):$($_.RemotePort)" })
  $result.Strays = @($tcp | Where-Object State -eq 'Listen' | ForEach-Object { "listen $($_.LocalAddress):$($_.LocalPort)" }) +
    @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and -not (& $ok $_.LocalAddress) } |
      ForEach-Object { "udp $($_.LocalAddress):$($_.LocalPort)" })
  $result
}

# ---------- exit check ----------

# Asks the provider's check page which IP the tunnel exits from, using a socket bound to the tunnel.
function Test-TvExit($Config) {
  $json = & curl.exe -s -m 12 --interface $Config.address $Config.checkUrl 2>$null
  if (-not $json) { return [pscustomobject]@{ ok = $false; ip = $null; provider = $null; error = 'no answer through the tunnel' } }
  try { $j = ($json -join '') | ConvertFrom-Json } catch { return [pscustomobject]@{ ok = $false; ip = $null; provider = $null; error = 'unexpected answer' } }
  $isVpn = $null
  if ($null -ne $j.mullvad_exit_ip) { $isVpn = [bool]$j.mullvad_exit_ip }
  [pscustomobject]@{ ok = $true; ip = $j.ip; provider = $isVpn; city = $j.city; country = $j.country; server = $j.mullvad_exit_ip_hostname; error = $null }
}

function Get-TvHomeIp {
  $ip = & curl.exe -s -m 8 https://api.ipify.org 2>$null
  if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') { return $ip }
  $null
}

Export-ModuleMember -Function *
