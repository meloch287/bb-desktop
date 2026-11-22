param(
  [string]$Installer = "dist/bb-setup.exe",
  [string]$PreviousInstaller = "build/cache/bb-setup-1.4.2.exe"
)
$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -ne "true") { throw "Installer smoke is restricted to disposable GitHub runners" }
if (!$IsWindows) { throw "Windows runner required" }
$installDir = Join-Path $env:RUNNER_TEMP "bb-install-smoke"
$profile = Join-Path $env:APPDATA "bb"
$settings = Join-Path $profile "settings.json"
$sentinel = '{"gpu":false,"smoothScroll":true,"glassOpacity":61}'
$registryKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\496ef164-98f2-5287-85cd-e8fbc166be1d"

function Stop-SmokeApp {
  Get-Process -Name bb -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($installDir) } | Stop-Process -Force
}
function Install-Bb([string]$Path) {
  $p = Start-Process -FilePath (Resolve-Path $Path) -ArgumentList @("/S", "/currentuser", "/D=$installDir") -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Installer failed: $($p.ExitCode)" }
  Stop-SmokeApp
}

New-Item -ItemType Directory -Force $profile | Out-Null
[IO.File]::WriteAllText($settings, $sentinel)
try {
  Install-Bb $PreviousInstaller
  if (!(Test-Path $registryKey)) { throw "Official installer identity differs from the expected GUID" }
  Install-Bb $Installer
  $version = (Get-Content package.json | ConvertFrom-Json).version
  $installed = Get-ItemProperty $registryKey
  if ($installed.DisplayVersion -ne $version) { throw "Upgrade did not replace the existing registration" }
  if ([IO.File]::ReadAllText($settings) -ne $sentinel) { throw "Upgrade changed existing settings" }
  node scripts/native-smoke.cjs (Join-Path $installDir "bb.exe")
  if ($LASTEXITCODE -ne 0) { throw "Native application smoke failed" }
  $p = Start-Process -FilePath (Join-Path $installDir "Uninstall bb.exe") -ArgumentList "/S" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Uninstaller failed: $($p.ExitCode)" }
  for ($i = 0; $i -lt 30 -and (Test-Path (Join-Path $installDir "bb.exe")); $i++) { Start-Sleep -Seconds 1 }
  if (Test-Path (Join-Path $installDir "bb.exe")) { throw "Uninstaller left the installed application" }
  if ([IO.File]::ReadAllText($settings) -ne $sentinel) { throw "Uninstall deleted or changed existing settings" }
  Write-Host "Installer smoke passed: official 1.4.2 upgrade, native launch, uninstall, settings preserved"
} finally {
  Stop-SmokeApp
}
