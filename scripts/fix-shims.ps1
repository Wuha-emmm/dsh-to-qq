# Re-create the root `index.js` shims that profile-installed plugins need.
#
# Why: DSH resolves bare `@deepseek-ai/*` imports made *inside* a profile package
# by appending `/index.js` to the package directory. Published packages put their
# entry under `lib/`, so the resolution fails. A one-line re-export at the package
# root fixes it.
#
# When: after any `pnpm install` that touches these packages (a plugin install can
# re-link them from the store and drop the added file). Idempotent.
#
# Usage: pwsh -File scripts\fix-shims.ps1 [-ProfileNodeModules <path>]

param(
  [string]$ProfileNodeModules = ''
)

if ($ProfileNodeModules -eq '') {
  $profileDir = $env:DSH_PROFILE_DIR
  if (-not $profileDir) {
    $name = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
    $profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $name
  }
  $ProfileNodeModules = Join-Path $profileDir 'node_modules'
}

$ErrorActionPreference = 'Stop'
$base = Join-Path $ProfileNodeModules '@deepseek-ai'
if (-not (Test-Path $base)) { throw "not found: $base" }

$esm = @(
  'import * as namespace from ''./lib/index.js'';',
  'export * from ''./lib/index.js'';',
  'export default namespace.default;'
) -join "`n"

$written = 0
foreach ($name in 'dsh-credentials', 'dsh-llm', 'dsh-home-paths') {
  $dir = Join-Path $base $name
  if (-not (Test-Path $dir)) { Write-Host "skip $name (not installed)"; continue }
  Set-Content -Path (Join-Path $dir 'index.js') -Value $esm -Encoding UTF8
  $written += 1
}

# schemastery ships an ESM bundle at lib/index.mjs.
$sche = Join-Path $base 'schemastery'
if (Test-Path $sche) {
  $shim = @(
    'import * as namespace from ''./lib/index.mjs'';',
    'export * from ''./lib/index.mjs'';',
    'export default namespace.default;'
  ) -join "`n"
  Set-Content -Path (Join-Path $sche 'index.js') -Value $shim -Encoding UTF8
  $written += 1
}

Write-Host "wrote $written shim(s) under $base"
