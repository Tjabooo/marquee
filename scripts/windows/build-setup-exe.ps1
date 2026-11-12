# Builds LilinSetup.exe: the setup wizard and install.ps1 wrapped in a small launcher, so
# Windows users can double-click one file. Uses the C# compiler that ships with Windows
# (.NET Framework 4), so it needs nothing installed. The release workflow runs it; locally:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\build-setup-exe.ps1 -Version v1.2.0
param(
  [Parameter(Mandatory)][string]$Version,              # the release the exe installs, e.g. v1.2.0
  [string]$Out = (Join-Path (Get-Location) 'LilinSetup.exe')
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($Version -notmatch '^v(\d+)\.(\d+)\.(\d+)') { throw "Version must look like v1.2.3 (got $Version)" }
$assembly = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "The .NET Framework 4 C# compiler wasn't found ($csc)." }

$work = Join-Path ([IO.Path]::GetTempPath()) ('lilin-exe-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
try {
  $src = (Get-Content (Join-Path $PSScriptRoot 'LilinSetup.cs') -Raw).Replace('__ASSEMBLY_VERSION__', $assembly).Replace('__VERSION__', $Version)
  [IO.File]::WriteAllText((Join-Path $work 'LilinSetup.cs'), $src)

  # The app icon: Lilin's 192 px PNG inside an .ico (Windows Vista and later read PNG icons).
  $png = [IO.File]::ReadAllBytes((Join-Path $root 'public\icon-192.png'))
  $ico = New-Object IO.MemoryStream
  $w = New-Object IO.BinaryWriter $ico
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)                  # header: icon, 1 image
  $w.Write([byte]192); $w.Write([byte]192); $w.Write([byte]0); $w.Write([byte]0)  # 192x192, no palette
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
  $w.Write($png); $w.Flush()
  [IO.File]::WriteAllBytes((Join-Path $work 'lilin.ico'), $ico.ToArray())

  $wizard = Join-Path $PSScriptRoot 'setup-wizard.ps1'
  $install = Join-Path $root 'install.ps1'
  & $csc /nologo /target:winexe /optimize+ /platform:anycpu "/out:$Out" "/win32icon:$(Join-Path $work 'lilin.ico')" `
    /reference:System.Windows.Forms.dll "/resource:$wizard,setup-wizard.ps1" "/resource:$install,install.ps1" (Join-Path $work 'LilinSetup.cs')
  if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
  $hash = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower()
  Write-Host "Built $Out ($([math]::Round((Get-Item $Out).Length / 1KB)) KB) for Lilin $Version, sha256 $hash"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
