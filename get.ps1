# cc-termux bootstrap installer for Windows.
#
#   irm https://raw.githubusercontent.com/SehonYT/cc-termux/main/get.ps1 | iex
#
# Environment:
#   CC_TERMUX_REPO     GitHub owner/repo (default: SehonYT/cc-termux)
#   CC_TERMUX_REF      branch or tag (default: main)
#   CC_TERMUX_ARCHIVE  use a local .tar.gz instead of downloading (testing/offline)
$ErrorActionPreference = "Stop"

$Repo = if ($env:CC_TERMUX_REPO) { $env:CC_TERMUX_REPO } else { "SehonYT/cc-termux" }
$Ref = if ($env:CC_TERMUX_REF) { $env:CC_TERMUX_REF } else { "main" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 18+ is required (https://nodejs.org)" }

$Tmp = Join-Path $env:TEMP ("cc-termux-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  $Archive = Join-Path $Tmp "src.tar.gz"
  if ($env:CC_TERMUX_ARCHIVE) {
    Copy-Item $env:CC_TERMUX_ARCHIVE $Archive
  } else {
    Invoke-WebRequest "https://codeload.github.com/$Repo/tar.gz/refs/heads/$Ref" -OutFile $Archive -UseBasicParsing
  }
  $Src = Join-Path $Tmp "src"
  New-Item -ItemType Directory -Path $Src | Out-Null
  tar -xzf $Archive -C $Src
  $Install = Get-ChildItem -Path $Src -Filter install.mjs -Recurse -Depth 1 | Select-Object -First 1
  if (-not $Install) { throw "install.mjs not found in archive" }
  node $Install.FullName @args
  exit $LASTEXITCODE
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
