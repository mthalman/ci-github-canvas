<#
.SYNOPSIS
    Installs ci-github-canvas as a user-scoped Copilot CLI extension by symlinking
    this repo's extension.mjs into the Copilot extensions directory.

.DESCRIPTION
    Creates symbolic links at
        $env:USERPROFILE\.copilot\extensions\<Name>\extension.mjs
        $env:USERPROFILE\.copilot\extensions\<Name>\lib
    pointing at this repo's extension.mjs and lib folder, so edits made in the
    repo are picked up by the next `extensions_reload` (or session restart) —
    no copy step needed.

    Windows note: creating a symbolic link without elevation requires Developer Mode
    to be enabled. If the link creation fails with a permission error, either:
      1. Enable Developer Mode in Windows Settings, or
      2. Re-run this script from an elevated PowerShell prompt.

.PARAMETER Name
    Folder name to create under the Copilot extensions directory. Defaults to
    'ci-runs' so it matches the canvas id declared by the extension.

.PARAMETER Force
    If the destination already exists (as a regular file, a symlink, or a junction),
    remove it before creating the new symlink. Without -Force, the script aborts to
    avoid clobbering an installed extension.

.EXAMPLE
    pwsh .\install-dev-link.ps1
    # Symlinks extension.mjs to ~/.copilot/extensions/ci-runs/extension.mjs.

.EXAMPLE
    pwsh .\install-dev-link.ps1 -Name ci-runs-dev -Force
    # Installs under a different folder name so it doesn't collide with an
    # already-installed copy, replacing any prior dev link.
#>
[CmdletBinding()]
param(
    [string] $Name = 'ci-runs',
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

# Resolve the repo paths we want to link to — always absolute, regardless of cwd.
$repoRoot     = Split-Path -Parent $PSCommandPath
$sourceFile   = Join-Path $repoRoot 'extension.mjs'
$sourceLibDir = Join-Path $repoRoot 'lib'
$extensionsDir = Join-Path $env:USERPROFILE '.copilot\extensions'
$targetDir    = Join-Path $extensionsDir $Name
$targetFile   = Join-Path $targetDir 'extension.mjs'
$targetLibDir = Join-Path $targetDir 'lib'

if (-not (Test-Path $sourceFile)) {
    Write-Error "Source not found: $sourceFile"
    exit 1
}

if (-not (Test-Path $sourceLibDir)) {
    Write-Error "Source lib folder not found: $sourceLibDir"
    exit 1
}

if (-not (Test-Path $extensionsDir)) {
    Write-Error "Copilot extensions directory not found: $extensionsDir`nIs the Copilot CLI installed for this user?"
    exit 1
}

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir | Out-Null
    Write-Host "Created $targetDir"
}

function New-DevSymlink {
    param(
        [Parameter(Mandatory)] [string] $LinkPath,
        [Parameter(Mandatory)] [string] $TargetPath,
        [switch] $ForceReplace
    )

    if (Test-Path $LinkPath) {
        $existing = Get-Item $LinkPath -Force
        $isLink   = $existing.LinkType -in @('SymbolicLink', 'Junction')

        if ($isLink -and $existing.Target -contains $TargetPath) {
            Write-Host "Already linked: $LinkPath -> $TargetPath"
            return
        }

        if (-not $ForceReplace) {
            Write-Error "Destination already exists: $LinkPath`nUse -Force to replace it."
            exit 1
        }

        # Remove-Item -Force on a symlink (file or dir) removes only the link,
        # not the target. -Recurse is needed when the existing entry is a real
        # directory rather than a symlink.
        Remove-Item -Force -Recurse $LinkPath
        Write-Host "Removed existing $LinkPath"
    }

    try {
        New-Item -ItemType SymbolicLink -Path $LinkPath -Target $TargetPath | Out-Null
    } catch {
        Write-Error @"
Failed to create symbolic link: $_

Windows requires elevation OR Developer Mode for symbolic links. Try one of:
  - Enable Developer Mode (Settings > For developers)
  - Re-run this script from an elevated PowerShell prompt
"@
        exit 1
    }
    Write-Host "Linked: $LinkPath -> $TargetPath" -ForegroundColor Green
}

New-DevSymlink -LinkPath $targetFile  -TargetPath $sourceFile   -ForceReplace:$Force
New-DevSymlink -LinkPath $targetLibDir -TargetPath $sourceLibDir -ForceReplace:$Force

Write-Host ""
Write-Host ""
Write-Host "Reload extensions in any running Copilot CLI session to activate:" -ForegroundColor Cyan
Write-Host "  /reload-extensions"
Write-Host ""
Write-Host "Or ask the agent: 'reload extensions'."
