param(
  [string]$RepoRoot = (Split-Path -Parent $PSCommandPath)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Location $RepoRoot

function Run-Git {
  param([string[]]$GitArgs)
  $prevErr = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git @GitArgs 2>&1
  } finally {
    $ErrorActionPreference = $prevErr
  }
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArgs -join ' ') failed: $out"
  }
  return ($out | Out-String).Trim()
}

$indexPath = Join-Path $RepoRoot 'beta/index.html'
if (-not (Test-Path $indexPath)) {
  throw "Missing file: $indexPath"
}

$headShort = Run-Git -GitArgs @('rev-parse', '--short', 'HEAD')
$commitCount = Run-Git -GitArgs @('rev-list', '--count', 'HEAD')
$today = Get-Date -Format 'yyyy-MM-dd'

$versionCore = "0.1.$commitCount-beta"
$appVersion = "$versionCore / $today / $headShort"
$cacheBust = "$versionCore-$today-$headShort"

$raw = [System.IO.File]::ReadAllText($indexPath)
$updated = $raw

$updated = [regex]::Replace(
  $updated,
  '(?m)(<div class="app-version" style="[^"]*">v)([^<]*)(</div>)',
  ('${1}' + $appVersion + '${3}'),
  1
)

$updated = [regex]::Replace(
  $updated,
  '(?m)(<div class="app-version" id="appVersion">v<span>)([^<]*)(</span></div>)',
  ('${1}' + $appVersion + '${3}'),
  1
)

$updated = [regex]::Replace(
  $updated,
  "(?m)(const APP_VERSION = ')([^']*)(';)",
  ('${1}' + $appVersion + '${3}'),
  1
)

$updated = [regex]::Replace(
  $updated,
  "(?m)(const POLICY_CACHE_BUST = ')([^']*)(';)",
  ('${1}' + $cacheBust + '${3}'),
  1
)

$updated = [regex]::Replace(
  $updated,
  '(?m)(<script src="camera-scorer\.js)(\?v=[^"]*)?("\></script>)',
  ('${1}?v=' + $cacheBust + '${3}'),
  1
)

if ($updated -ne $raw) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($indexPath, $updated, $utf8NoBom)
}

Run-Git -GitArgs @('add', 'beta/index.html') | Out-Null
Run-Git -GitArgs @('add', '-A') | Out-Null

$status = Run-Git -GitArgs @('status', '--porcelain')
if (-not $status) {
  Write-Host 'No changes to commit.'
  exit 0
}

$msg = "beta publish: $versionCore"
Run-Git -GitArgs @('commit', '-m', $msg) | Out-Null
Run-Git -GitArgs @('push') | Out-Null

$newHead = Run-Git -GitArgs @('rev-parse', '--short', 'HEAD')
Write-Host "Published commit: $newHead"
Write-Host "Stamped APP_VERSION: $appVersion"
