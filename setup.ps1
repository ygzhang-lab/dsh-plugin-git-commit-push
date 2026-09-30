<#
.SYNOPSIS
  Install dsh-plugin-git-commit-push into the active DSH profile.

.DESCRIPTION
  Wires the plugin into the profile's bundle stack in three deliberate steps:

    1. adds the plugin to the profile's package.json as a `link:` dependency;
    2. appends the package to `dsh.profile.bundles`;
    3. appends the plugin's mount row to the profile's cordis.patch.yml.

  Step 1 and 2 change the bundle set, which a running profile does not pick up:
  DSH must be restarted afterwards. Step 3 alone would hot-reload, but the
  package has to be linked before it can be mounted. Every write is idempotent —
  run this as many times as you like — and a backup of each file is written
  before the first modification.

  Nothing here touches your git configuration, your repositories, or any DSH
  setting other than the three edits above.

.PARAMETER Profile
  Profile name under $env:USERPROFILE\.dsh\profiles. Defaults to `desktop`.

.PARAMETER Uninstall
  Reverses the three edits and removes the linked package.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\local-plugins\dsh-plugin-git-commit-push\setup.ps1"
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
foreach ($file in @($packageJsonPath, $patchPath)) {
  $backup = $file + '.git-commit-plugin.bak'
  if (-not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $file -Destination $backup
    Write-Ok "backed up $(Split-Path -Leaf $file) -> $(Split-Path -Leaf $backup)"
  }
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

# The plugin is mounted by an EXPLICIT insert row in this profile's
# cordis.patch.yml. That is not a stylistic choice: it was measured. With the
# package linked and listed in dsh.profile.bundles but no row here, the loader
# exposed no mount entry for this package at all and the plugin never loaded —
# the bundle channel alone was not sufficient on the reserved `desktop` profile.
# (The package therefore declares no `dsh.bundle.patch`; this row is the one
# and only mount, so there is no double-mount to guard against.)
#
# The marker block makes the edit idempotent and removable: it is stripped and
# rewritten on every run, so repeated installs cannot stack two rows.
$beginMarker = '# >>> dsh-plugin-git-commit-push'
$endMarker = '# <<< dsh-plugin-git-commit-push'
$patchText = Get-Content -LiteralPath $patchPath -Raw
$existingBlock = [regex]::Match($patchText, "(?s)\s*$([regex]::Escape($beginMarker)).*?$([regex]::Escape($endMarker))")
if ($existingBlock.Success) {
  $patchText = $patchText.Remove($existingBlock.Index, $existingBlock.Length)
  $patchText = $patchText -replace "(\r?\n){3,}", "`n`n"
}
if ($Uninstall) {
  [System.IO.File]::WriteAllText($patchPath, "$($patchText.TrimEnd())`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok 'cordis.patch.yml: mount row removed'
} else {
  $block = @(
    $beginMarker
    '- insert:'
    '    - id: git-commit-push'
    "      name: '$pluginName'"
    $endMarker
  ) -join "`n"
  $combined = "$($patchText.TrimEnd())`n`n$block`n"
  [System.IO.File]::WriteAllText($patchPath, $combined, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok 'cordis.patch.yml: mount row inserted'
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
$linkedModule = Join-Path $profileDir "node_modules\$pluginName"
if (Test-Path -LiteralPath $linkedModule) {
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
  Write-Host '  Settings live in:' -ForegroundColor Gray
  Write-Host "    $(Join-Path $pluginDir 'git-commit-push.config.json')" -ForegroundColor Gray
  Write-Host ''
  Write-Host '  If anything goes wrong, restore the backed-up profile files:' -ForegroundColor Gray
  Write-Host "    $(Join-Path $profileDir 'package.json.git-commit-plugin.bak')" -ForegroundColor Gray
  Write-Host "    $(Join-Path $profileDir 'cordis.patch.yml.git-commit-plugin.bak')" -ForegroundColor Gray
  Write-Host ''
} else {
  Write-Host ''
  Write-Host 'Uninstalled. Restart DeepSeek Harness for the bundle set to change.' -ForegroundColor White
  Write-Host 'Backups of your original profile files are next to them (*.git-commit-plugin.bak).' -ForegroundColor Gray
  Write-Host ''
}

exit 0
