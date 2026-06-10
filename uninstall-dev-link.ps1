<#
.SYNOPSIS
    Removes the dev-link symlink created by install-dev-link.ps1.

.PARAMETER Name
    Folder name under the Copilot extensions directory to remove. Defaults to
    'ci-runs' to match install-dev-link.ps1.

.EXAMPLE
    pwsh .\uninstall-dev-link.ps1
#>
[CmdletBinding()]
param(
    [string] $Name = 'ci-runs'
)

$ErrorActionPreference = 'Stop'

$targetDir = Join-Path $env:USERPROFILE ".copilot\extensions\$Name"

if (-not (Test-Path $targetDir)) {
    Write-Host "Nothing to remove at $targetDir"
    exit 0
}

# Refuse to remove if the folder contains anything we didn't put there —
# we only want to clean up our own dev link, not nuke a hand-installed copy.
# The install script creates two symlinks: extension.mjs and lib/.
$entries = Get-ChildItem -Force $targetDir
$expectedNames = @('extension.mjs', 'lib')
$onlyOurs = $true
foreach ($e in $entries) {
    if ($e.Name -notin $expectedNames) { $onlyOurs = $false; break }
    if ($e.LinkType -notin @('SymbolicLink', 'Junction')) { $onlyOurs = $false; break }
}
if ($onlyOurs -and $entries.Count -gt $expectedNames.Count) { $onlyOurs = $false }

if (-not $onlyOurs) {
    Write-Error @"
Refusing to remove $targetDir — it contains files other than the dev-link symlinks
(expected: extension.mjs symlink and lib symlink only).

Remove it manually if you're sure:
  Remove-Item -Recurse -Force '$targetDir'
"@
    exit 1
}

Remove-Item -Recurse -Force $targetDir
Write-Host "Removed $targetDir" -ForegroundColor Green
