# Marquee installer and updater for Windows 10/11. Read it before running it; it is short.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1                    install or update to the latest release
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Version v1.1.0    a specific release
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Dir D:\Apps\Marquee somewhere other than %USERPROFILE%\marquee
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall          remove the scheduled tasks and application files
#                                                                            (.env, database and media stay)
#
# It downloads marquee-<version>.tar.gz and SHA256SUMS from the GitHub release, checks the archive
# against the checksum and unpacks it. Updates replace application files only; .env, the database,
# state files and cache\ are never touched, and the previous version is kept in .backup-<version>\.
param(
  [string]$Version = '',
  [string]$Dir = (Join-Path $env:USERPROFILE 'marquee'),
  [switch]$DryRun,
  [switch]$NoSetup,
  [switch]$Yes,
  [switch]$Uninstall,
  [switch]$Purge
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = 'Tjabooo/marquee'
$AppItems = 'server.js', 'setup.js', 'package.json', 'src', 'public', 'agents', 'scripts', 'tools', 'docs', 'start-marquee.cmd',
  '.env.example', 'README.md', 'CHANGELOG.md', 'Dockerfile', 'docker-compose.yml', 'docker', 'install.sh', 'install.ps1'

function Step([string]$text, [scriptblock]$action) {
  if ($DryRun) { Write-Host "  would: $text" } else { & $action }
}

if ($Uninstall) {
  if (-not (Test-Path (Join-Path $Dir 'server.js'))) { throw "No Marquee installation in $Dir" }
  Write-Host "Removing Marquee from $Dir"
  $svc = Join-Path $Dir 'scripts\windows\install-service.ps1'
  if ((Test-Path $svc) -and (Get-ScheduledTask -TaskName 'Marquee' -ErrorAction SilentlyContinue)) {
    Step 'remove the scheduled tasks' { & powershell -NoProfile -ExecutionPolicy Bypass -File $svc -Uninstall }
  }
  foreach ($item in $AppItems) {
    $p = Join-Path $Dir $item
    if (Test-Path $p) { Step "delete $p" { Remove-Item -Recurse -Force $p } }
  }
  # Left by the setup wizard (MarqueeSetup.exe): its copy and the Start menu entries.
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Marquee'
  foreach ($p in (Join-Path $Dir 'MarqueeSetup.exe'), $menu) {
    if (Test-Path $p) { Step "delete $p" { Remove-Item -Recurse -Force $p } }
  }
  if ($Purge) {
    Write-Host "-Purge deletes EVERYTHING in $Dir, including .env, the database, Notes and cache." -ForegroundColor Yellow
    if ((Read-Host 'Type the folder path to confirm') -ne $Dir) { throw 'Not confirmed; data kept.' }
    Step "delete $Dir" { Remove-Item -Recurse -Force $Dir }
    Write-Host "Deleted $Dir. Media folders elsewhere were not touched."
  } else {
    Write-Host "Application files removed. Kept: .env, the database, state files and cache\ in $Dir."
  }
  exit 0
}

# ---------- prerequisites ----------
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeOk = $false
if ($node) {
  $v = [version]((& node --version).TrimStart('v'))
  $nodeOk = $v -ge [version]'22.16.0'
}
if (-not $nodeOk) {
  Write-Host 'Marquee needs Node.js 22.16 or later. Install the LTS, open a new PowerShell and run this again:' -ForegroundColor Yellow
  Write-Host '  winget install OpenJS.NodeJS.LTS'
  exit 1
}
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'tar.exe is missing (it ships with Windows 10 1803 and later).' }

# ---------- version ----------
if (-not $Version) {
  $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing).tag_name
  if (-not $Version) { throw "Couldn't find the latest release; pass -Version vX.Y.Z" }
}
if (-not $Version.StartsWith('v')) { $Version = "v$Version" }
Write-Host "Marquee $Version -> $Dir"

if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "$Dir is a git checkout. Update it with git instead:"
  Write-Host "  cd `"$Dir`"; git fetch --tags; git checkout $Version   (or: git pull --ff-only)"
  exit 1
}
$current = $null
$pkg = Join-Path $Dir 'package.json'
if (Test-Path $pkg) { $current = (Get-Content $pkg -Raw | ConvertFrom-Json).version; Write-Host "Found Marquee ${current}: updating application files only" }

# ---------- download and verify ----------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("marquee-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
try {
  $base = "https://github.com/$Repo/releases/download/$Version"
  $archive = "marquee-$Version.tar.gz"
  Write-Host "Downloading $archive"
  Invoke-WebRequest "$base/$archive" -OutFile (Join-Path $tmp $archive) -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') -UseBasicParsing
  $want = (Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match " $([regex]::Escape($archive))$" } | ForEach-Object { ($_ -split ' ')[0] }) | Select-Object -First 1
  $got = (Get-FileHash (Join-Path $tmp $archive) -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want -ne $got) { throw "Checksum mismatch for $archive (expected $want, got $got); not installing." }
  Write-Host "Checksum OK ($got)"
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh attestation verify (Join-Path $tmp $archive) --repo $Repo *> $null
    if ($LASTEXITCODE -eq 0) { Write-Host 'Build provenance verified with gh' } else { Write-Host "Note: gh couldn't verify build provenance; the checksum still matched" }
  }

  # ---------- install ----------
  $stage = Join-Path $Dir ".update-$Version"
  Step "create $Dir" { New-Item -ItemType Directory -Force $Dir | Out-Null }
  if (Test-Path $stage) { Step 'remove a leftover staging folder' { Remove-Item -Recurse -Force $stage } }
  Step "unpack into $stage" {
    New-Item -ItemType Directory $stage | Out-Null
    & tar -xzf (Join-Path $tmp $archive) -C $stage --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'Unpacking failed.' }
  }
  if ($current) {
    $backup = Join-Path $Dir ".backup-$current"
    Step "keep the current version in $backup" {
      if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
      New-Item -ItemType Directory $backup | Out-Null
      foreach ($item in $AppItems) { $p = Join-Path $Dir $item; if (Test-Path $p) { Move-Item $p (Join-Path $backup $item) } }
    }
  }
  Step 'move the new version into place' {
    foreach ($item in $AppItems) { $p = Join-Path $stage $item; if (Test-Path $p) { Move-Item $p (Join-Path $Dir $item) } }
    Remove-Item -Recurse -Force $stage
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($DryRun) { Write-Host 'Dry run: nothing was changed.'; exit 0 }
if (-not $NoSetup) {
  if ($Yes) { & node (Join-Path $Dir 'setup.js') --yes } else { & node (Join-Path $Dir 'setup.js') }
}
if ($current) { Write-Host "Restart Marquee to use ${Version}: node `"$Dir\setup.js`" service restart" }
Write-Host "Done. Check the installation any time with: node `"$Dir\setup.js`" doctor"
