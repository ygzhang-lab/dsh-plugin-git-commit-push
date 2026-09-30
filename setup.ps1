<#
.SYNOPSIS
  Install a local CHECKOUT of dsh-plugin-git-commit-push into a DSH profile.

.DESCRIPTION
  Wires the plugin into the profile's bundle stack in two deliberate steps:

    1. adds the plugin to the profile's package.json as a `link:` dependency;
    2. appends the package to `dsh.profile.bundles`.

  Installing from npm does not need this script: use Settings > Plugins (type
  `dsh-plugin-git-commit-push`) or
  `dsh plugin --profile <profile> add dsh-plugin-git-commit-push`.
  This script is for a checkout you are editing, which should be linked rather
  than copied into node_modules.

  The mount row is deliberately NOT written into the profile's patch file: it
  comes from the package's own bundle patch (`cordis.patch.yml`, declared as
  `dsh.bundle.patch` in this package's package.json), which the launcher applies
  for every profile that selects the bundle. That declaration is also what makes
  the package manageable: the Plugins page can enable, disable and uninstall a
  bundle, and refuses every action on a package without one with the diagnostic
  "这个包没有声明组合包，不能作为插件管理" (`not-bundle`).

  A profile set up by an earlier revision of this script still carries a
  hand-written mount row in its cordis.patch.yml under the marker block below.
  Loader `insert` is append-only — two inserts of the same id mount the plugin
  twice — so this script strips that legacy block whenever it finds one.

  Steps 1 and 2 change the bundle set, which a running profile does not pick up:
  DSH must be restarted afterwards. Every write is idempotent — run this as many
  times as you like — and a backup of each file is written before the first
  modification.

  Nothing here touches your git configuration, your repositories, or any DSH
  setting other than the edits above.

.PARAMETER Profile
  Profile name under $env:USERPROFILE\.dsh\profiles. Defaults to `desktop`.

.PARAMETER Uninstall
  Reverses the two edits, strips a legacy mount row and removes the linked package.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Profile web
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$pluginDir = $PSScriptRoot
$pluginName = 'dsh-plugin-git-commit-push'
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profileDir = Join-Path $dshHome "profiles\$Profile"
$nodeExe = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpmCli = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

function Write-Step([string]$Text) { Write-Host "  $Text" }
function Write-Ok([string]$Text) { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  [info] $Text" -ForegroundColor Cyan }
function Write-Warn2([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }

Write-Host ''
Write-Host "dsh-plugin-git-commit-push $(if ($Uninstall) { 'uninstall' } else { 'install' })" -ForegroundColor White
Write-Host ''

# --- 1. Preconditions ------------------------------------------------------
if (-not (Test-Path -LiteralPath $profileDir)) {
  throw "Profile directory not found: $profileDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
  throw "Not a DSH profile (no package.json): $profileDir"
}

$packageJsonPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath)) {
  throw "Not a DSH profile (no cordis.patch.yml): $profileDir"
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $gitCmd) {
  Write-Warn2 'git was not found on PATH. The plugin needs it at runtime; install Git before using it.'
} else {
  Write-Ok "git found: $($gitCmd.Source)"
}

if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "Bundled node not found: $nodeExe`nSet it manually, or install the package with your own pnpm instead."
}
if (-not (Test-Path -LiteralPath $pnpmCli)) {
  throw "Bundled pnpm not found: $pnpmCli"
}
Write-Ok 'bundled node + pnpm located'

# --- 2. Back up once -------------------------------------------------------
# NOTE: the concatenation must be `$file + '.suffix'`, NOT "$file.suffix".
# Inside an expandable string PowerShell reads `.git-commit-plugin` as a
# PROPERTY access on $file, which yields $null — the backup would silently land
# in the current directory under a mangled name and the second file would never
# be backed up at all.
#
# The patch file is backed up further down, and only when this run actually has
# to change it (the legacy mount-row migration). A fresh install leaves it
# untouched.
$manifestBackup = $packageJsonPath + '.git-commit-plugin.bak'
if (-not (Test-Path -LiteralPath $manifestBackup)) {
  Copy-Item -LiteralPath $packageJsonPath -Destination $manifestBackup
  Write-Ok "backed up package.json -> $(Split-Path -Leaf $manifestBackup)"
}

# --- 3. Edit the profile manifest and patch layer --------------------------
# The manifest edit is delegated to lib/profile-edit.mjs, the SAME code setup.sh
# runs on macOS/Linux. Editing a user's profile package.json is the one step that
# must not go wrong, and two hand-written implementations of it would drift: this
# way one reviewed implementation (idempotent, keeps unknown fields, no BOM,
# self-verifying) serves both platforms.
$editArgs = @(
  "$pluginDir\lib\profile-edit.mjs"
  '--profile-dir', $profileDir
  '--package', $pluginName
)
if ($Uninstall) { $editArgs += '--remove' } else { $editArgs += @('--link', $pluginDir) }

& $nodeExe @editArgs
if ($LASTEXITCODE -ne 0) { throw "profile manifest edit failed with exit code $LASTEXITCODE" }
Write-Ok 'package.json updated'

# The plugin is mounted by the bundle patch this package ships
# (cordis.patch.yml, declared as dsh.bundle.patch). Nothing is written into the
# profile's own cordis.patch.yml on a fresh install.
#
# What this step does is the MIGRATION: an earlier revision of this script wrote
# a mount row into the profile patch instead, and Loader `insert` is
# append-only — leaving that row in place next to the bundle's own row would
# mount the plugin twice. So the marker block is stripped whenever it is found;
# the edit is idempotent (it is stripped and never rewritten) and the profile
# patch is backed up first, because this is the only run that may change it.
$beginMarker = '# >>> dsh-plugin-git-commit-push'
$endMarker = '# <<< dsh-plugin-git-commit-push'
$patchText = Get-Content -LiteralPath $patchPath -Raw
$existingBlock = [regex]::Match($patchText, "(?s)\s*$([regex]::Escape($beginMarker)).*?$([regex]::Escape($endMarker))")
if ($existingBlock.Success) {
  $patchBackup = $patchPath + '.git-commit-plugin.bak'
  if (-not (Test-Path -LiteralPath $patchBackup)) {
    Copy-Item -LiteralPath $patchPath -Destination $patchBackup
    Write-Ok "backed up cordis.patch.yml -> $(Split-Path -Leaf $patchBackup)"
  }
  $patchText = $patchText.Remove($existingBlock.Index, $existingBlock.Length)
  $patchText = $patchText -replace "(\r?\n){3,}", "`n`n"
  [System.IO.File]::WriteAllText($patchPath, "$($patchText.TrimEnd())`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok 'cordis.patch.yml: legacy mount row removed (the bundle patch mounts the plugin now)'
} else {
  Write-Ok 'cordis.patch.yml: no legacy mount row to remove'
}

# --- 4. Link the package ---------------------------------------------------
Write-Step 'running pnpm install in the profile (this may take a moment)...'
Push-Location $profileDir
# pnpm writes progress and warnings to stderr routinely. With
# $ErrorActionPreference = 'Stop' and a `2>&1` redirect, Windows PowerShell turns
# those into terminating errors, so the script would die before it could read
# $LASTEXITCODE. Relax the preference for the duration of the native call.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $nodeExe $pnpmCli install
  $pnpmExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
  Pop-Location
}
if ($pnpmExit -ne 0) { throw "pnpm install failed with exit code $pnpmExit" }
Write-Ok 'package linked into the profile'

# --- 5. Verify -------------------------------------------------------------
# On uninstall the linked directory is expected to be gone (pnpm pruned it in
# step 4); reporting that as a warning would read like a failure.
$linkedModule = Join-Path $profileDir "node_modules\$pluginName"
if ($Uninstall) {
  if (Test-Path -LiteralPath $linkedModule) {
    Write-Warn2 "node_modules\$pluginName is still present; run pnpm install in the profile to prune it"
  } else {
    Write-Ok "module removed from node_modules\$pluginName"
  }
} elseif (Test-Path -LiteralPath $linkedModule) {
  Write-Ok "module present at node_modules\$pluginName"
} else {
  Write-Warn2 "node_modules\$pluginName is missing; the profile will not find the plugin"
}

if (-not $Uninstall) {
  Write-Host ''
  Write-Host 'Done. Restart DeepSeek Harness to load the bundle.' -ForegroundColor White
  Write-Host ''
  Write-Host '  Close DeepSeek Harness first if it is running: a bundle addition is' -ForegroundColor Gray
  Write-Host '  read at profile start, not live. Then start it again.' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  After the restart you get:' -ForegroundColor Gray
  Write-Host '    - a tool named  git_commit_push   (prepare / apply / auto)' -ForegroundColor Gray
  Write-Host '    - a slash command  /commit-push   (runs without the model, 0 tokens)' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  The plugin is a declared bundle, so Settings > Plugins can now' -ForegroundColor Gray
  Write-Host '  enable, disable and uninstall it without this script.' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  Settings live in:' -ForegroundColor Gray
  Write-Host "    $(Join-Path $pluginDir 'git-commit-push.config.json')" -ForegroundColor Gray
  Write-Host ''
  Write-Host '  If anything goes wrong, restore the backed-up profile files:' -ForegroundColor Gray
  Write-Host "    $(Join-Path $profileDir 'package.json.git-commit-plugin.bak')" -ForegroundColor Gray
  Write-Host '    cordis.patch.yml.git-commit-plugin.bak  (only if the migration touched it)' -ForegroundColor Gray
  Write-Host ''
} else {
  Write-Host ''
  Write-Host 'Uninstalled. Restart DeepSeek Harness for the bundle set to change.' -ForegroundColor White
  Write-Host 'Backups of your original profile files are next to them (*.git-commit-plugin.bak).' -ForegroundColor Gray
  Write-Host ''
}

exit 0
