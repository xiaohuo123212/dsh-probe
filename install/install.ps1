param(
  [string]$Profile = '',
  [string]$Dsh = '',
  [ValidateSet('pack', 'link')][string]$Mode = 'pack',
  [string]$Source = '',
  [switch]$Check,
  [switch]$Uninstall,
  [switch]$DryRun
)

# Install, upgrade, inspect or remove dsh-probe for one DSH profile.
#
# Default mode "pack": this checkout is packed into
#   %USERPROFILE%\.dsh\plugins\dsh-probe\dsh-probe-<version>.tgz
# and the profile depends on that copy. Moving or deleting the checkout no longer
# breaks the profile - re-run this script after code changes to repack.
#
# "-Mode link" keeps the old behaviour (profile points straight at this checkout):
# handy while editing, but the checkout must stay where it is.
#
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
$ErrorActionPreference = 'Stop'

$bundleName = 'dsh-probe'
$bundleDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$storeDir = Join-Path $env:USERPROFILE ".dsh\plugins\$bundleName"

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Ensure-Property($Object, [string]$Name, $Value) {
  if (-not ($Object.PSObject.Properties.Name -contains $Name)) {
    $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  }
}

function Read-JsonFile([string]$Path) {
  return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Value) {
  Write-Utf8NoBom -Path $Path -Text ($Value | ConvertTo-Json -Depth 30)
}

function Find-DshCli {
  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  }
  $onPath = Get-Command dsh -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return ''
}

function Get-DependencySpec($Package, [string]$Name) {
  if (-not ($Package.PSObject.Properties.Name -contains 'dependencies')) { return '' }
  if (-not ($Package.dependencies.PSObject.Properties.Name -contains $Name)) { return '' }
  return [string]$Package.dependencies.$Name
}

function Set-BundleEntry([string]$PackagePath, [bool]$Add) {
  $package = Read-JsonFile $PackagePath
  Ensure-Property $package 'dsh' ([pscustomobject]@{})
  Ensure-Property $package.dsh 'profile' ([pscustomobject]@{})
  $bundles = @()
  if ($package.dsh.profile.PSObject.Properties.Name -contains 'bundles') {
    $bundles = @($package.dsh.profile.bundles)
  }
  if ($Add) {
    if (-not ($bundles -contains $bundleName)) { $bundles += $bundleName }
  } else {
    $bundles = @($bundles | Where-Object { $_ -ne $bundleName })
    if ($package.dsh.profile.PSObject.Properties.Name -contains 'bundles') {
      $package.dsh.profile.bundles = @($bundles)
      Write-JsonFile $PackagePath $package
      return
    }
  }
  $package.dsh.profile.bundles = @($bundles)
  Write-JsonFile $PackagePath $package
}

# ---- resolve profile and CLI -------------------------------------------------

if ($Profile -eq '') {
  $Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
}
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$packagePath = Join-Path $profileDir 'package.json'

if ($Dsh -eq '') { $Dsh = Find-DshCli }

Write-Host "bundle:  $bundleDir"
Write-Host "profile: $profileDir"

# ---- -Check: report the current wiring, no writes ----------------------------

if ($Check) {
  if (-not (Test-Path -LiteralPath $packagePath)) {
    Write-Host "status:  no profile package.json at $packagePath"
    exit 1
  }
  $package = Read-JsonFile $packagePath
  $spec = Get-DependencySpec $package $bundleName
  $entry = $false
  if ($package.dsh -and $package.dsh.profile -and $package.dsh.profile.bundles) {
    $entry = @($package.dsh.profile.bundles) -contains $bundleName
  }
  if ($spec -eq '') {
    Write-Host 'status:  not installed'
    exit 1
  }
  if ($spec -like 'link:*') {
    $target = $spec.Substring(5)
    if (Test-Path -LiteralPath $target) {
      Write-Host "status:  ok (link -> $target)"
      Write-Host 'note:    a link breaks if that directory moves; re-run with -Mode pack to make it move-proof.'
      exit 0
    }
    Write-Host "status:  BROKEN (link -> $target does not exist)"
    Write-Host "fix:     run this script again from the checkout's new location (default -Mode pack)."
    exit 2
  }
  if ($spec -like 'file:*') {
    $file = $spec.Substring(5)
    if (Test-Path -LiteralPath $file) {
      Write-Host "status:  ok (packed -> $file)"
      if (-not $entry) {
        Write-Host 'warning: dependency exists but dsh.profile.bundles has no entry; re-run without -Check to repair.'
        exit 1
      }
      exit 0
    }
    Write-Host "status:  BROKEN (packed file missing: $file)"
    exit 2
  }
  Write-Host "status:  unknown spec: $spec"
  exit 1
}

# ---- build or reuse the source spec -----------------------------------------

$forceReplace = $false
if ($Source -ne '') {
  $sourceSpec = $Source
} elseif ($Mode -eq 'link') {
  $sourceSpec = "link:$bundleDir"
} else {
  $manifest = Read-JsonFile (Join-Path $bundleDir 'package.json')
  $tgzName = "$($manifest.name)-$($manifest.version).tgz"
  $tgzPath = Join-Path $storeDir $tgzName
  $hashFile = Join-Path $storeDir 'packed.sha256'
  $sourceSpec = 'file:' + ($tgzPath -replace '\\', '/')
  if (-not $DryRun) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
      throw 'npm not found; Node.js installs it. Or pass -Mode link / -Source <spec>.'
    }
    New-Item -ItemType Directory -Force -Path $storeDir | Out-Null
    Get-ChildItem -LiteralPath $storeDir -Filter '*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
    Push-Location $bundleDir
    try {
      & npm pack --pack-destination $storeDir --silent | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "npm pack failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
    if (-not (Test-Path -LiteralPath $tgzPath)) { throw "npm pack did not produce $tgzName" }
    # pnpm pins a file: tarball by path + integrity, so a repacked tarball at the same
    # path is silently ignored ("Already up to date"). Force a replace when the bytes move.
    $packedHash = (Get-FileHash -LiteralPath $tgzPath -Algorithm SHA256).Hash
    $previousHash = if (Test-Path -LiteralPath $hashFile) { (Get-Content -LiteralPath $hashFile -Raw).Trim() } else { '' }
    $forceReplace = ($previousHash -ne $packedHash)
    Write-Host "packed:  $tgzPath"
  } else {
    Write-Host "packed:  (would write) $tgzPath"
  }
}
Write-Host "source:  $sourceSpec"

if ($DryRun) {
  if ($Uninstall) {
    Write-Host 'Dry run: would remove the dependency, drop the bundles entry and delete the packed copies.'
  } else {
    Write-Host "Dry run: would run dsh plugin add $sourceSpec, then ensure the bundles entry."
  }
  exit 0
}

if ($Dsh -eq '' -or -not (Test-Path -LiteralPath $Dsh)) {
  throw 'dsh CLI not found. Pass -Dsh <path to dsh.cmd>.'
}

# ---- uninstall ---------------------------------------------------------------

if ($Uninstall) {
  Write-Host 'Uninstalling...'
  Copy-Item -LiteralPath $packagePath -Destination "$packagePath.dsh-probe-backup" -Force
  Set-BundleEntry $packagePath $false
  & $Dsh plugin --profile $Profile remove $bundleName
  if ($LASTEXITCODE -ne 0) { Write-Warning "pnpm remove exited with $LASTEXITCODE; the dependency may already be gone." }
  if (Test-Path -LiteralPath $storeDir) {
    Remove-Item -LiteralPath $storeDir -Recurse -Force
    Write-Host "removed packed copies: $storeDir"
  }
  Write-Host 'Done. Restart DeepSeek Harness to drop the tools.'
  exit 0
}

# ---- install / upgrade -------------------------------------------------------

Copy-Item -LiteralPath $packagePath -Destination "$packagePath.dsh-probe-backup" -Force

# pnpm keeps an existing resolution when only the spec *kind* changes (link -> file),
# so replace the dependency whenever the spec differs from the previous one.
$previousSpec = ''
if (Test-Path -LiteralPath $packagePath) {
  $previousSpec = Get-DependencySpec (Read-JsonFile $packagePath) $bundleName
}
$kindChanged = ($previousSpec -ne '' -and $previousSpec -ne $sourceSpec)
if ($kindChanged -or ($forceReplace -and $previousSpec -ne '')) {
  if ($kindChanged) { Write-Host "replace: $previousSpec" } else { Write-Host 'replace: tarball content changed' }
  & $Dsh plugin --profile $Profile remove $bundleName | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "pnpm remove exited with $LASTEXITCODE; continuing with add." }
  # A link: install leaves a junction that pnpm does not track any more. Delete the
  # link itself (never its target) so the new spec is laid down as a real copy.
  $stale = Join-Path $profileDir "node_modules\$bundleName"
  if (Test-Path -LiteralPath $stale) {
    $attributes = [System.IO.File]::GetAttributes($stale)
    if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      [System.IO.Directory]::Delete($stale, $false)
      Write-Host "removed: stale link at node_modules\$bundleName"
    }
  }
}

& $Dsh plugin --profile $Profile add $sourceSpec
if ($LASTEXITCODE -ne 0) { throw "pnpm add failed with exit code $LASTEXITCODE" }
Set-BundleEntry $packagePath $true
if ($Mode -eq 'pack' -and $Source -eq '') {
  Write-Utf8NoBom -Path (Join-Path $storeDir 'packed.sha256') -Text $packedHash
}

# Show where the profile actually resolves the plugin, and flag a stale link.
$installedPath = Join-Path $profileDir "node_modules\$bundleName"
if (Test-Path -LiteralPath $installedPath) {
  $item = Get-Item -LiteralPath $installedPath -Force
  $target = (@($item.Target) -join '')
  if ($target -eq '') { $target = $installedPath }
  Write-Host "resolved: $target"
  if ($Mode -ne 'link' -and ($target -notlike '*\.dsh\*') -and ($target -notlike '*/.dsh/*')) {
    Write-Warning "node_modules\$bundleName does not point inside .dsh - the profile still depends on the checkout."
    Write-Warning "Run: powershell -ExecutionPolicy Bypass -File install\install.ps1 -Uninstall, then install again."
  }
}

Write-Host ''
Write-Host 'Installed. What happens next:'
if ($Mode -eq 'link') {
  Write-Host '  - link mode: the profile points straight at this checkout; keep the directory where it is.'
  Write-Host '  - switching to the move-proof default: re-run without -Mode link.'
} else {
  Write-Host '  - the profile depends on the packed copy, so moving or deleting this checkout is safe.'
  Write-Host '  - after editing the plugin, re-run this script to repack and upgrade.'
}
Write-Host '  - with HMR enabled the row activates without a restart; otherwise restart DeepSeek Harness.'
Write-Host '  - new sessions see the 9 probe_* tools and the probe skill.'
Write-Host ''
Write-Host 'Inspect:   powershell -ExecutionPolicy Bypass -File install\install.ps1 -Check'
Write-Host 'Uninstall: powershell -ExecutionPolicy Bypass -File install\install.ps1 -Uninstall'
