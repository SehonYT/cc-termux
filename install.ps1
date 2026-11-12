# modelmesh installer for Windows
$ErrorActionPreference = "Stop"

function Ensure-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $major = [int]((& node -p "process.versions.node.split('.')[0]"))
    if ($major -ge 18) { return "node" }
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $ver = if ($env:CC_NODE_VERSION) { $env:CC_NODE_VERSION } else { "v22.14.0" }
  $dir = Join-Path $HOME ".local\share\modelmesh\runtime"
  $cachedNode = Join-Path $dir "node-$ver-win-$arch\node.exe"
  if (Test-Path $cachedNode) {
    try { $cv = [int]((& $cachedNode -p "process.versions.node.split('.')[0]")); if ($cv -ge 18) { return $cachedNode } } catch { }
  }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $zip = Join-Path $env:TEMP ("node-" + [guid]::NewGuid().ToString("N") + ".zip")
  $url = "https://nodejs.org/dist/$ver/node-$ver-win-$arch.zip"
  Write-Host "modelmesh: downloading Node.js from $url" -ForegroundColor Cyan
  Invoke-WebRequest $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
  # Node publishes a checksum beside every build. Verify before extracting: a download that
  # is unpacked and executed must not be trusted on the strength of TLS alone.
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$ver/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 30).Content
  $want = ([regex]::Match($sums, "([0-9a-f]{64})\s+node-$ver-win-$arch\.zip")).Groups[1].Value
  if (-not $want) { throw "could not find a checksum for node-$ver-win-$arch.zip in SHASUMS256.txt" }
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { throw "checksum mismatch for $url (expected $want, got $got)" }
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  Remove-Item $zip -Force
  return (Join-Path $dir "node-$ver-win-$arch\node.exe")
}

$Node = Ensure-Node

# $PSScriptRoot is only set when this runs as a file. Piped through iex it is empty, and
# "$PSScriptRoot\install.mjs" would then be a path from the drive root. Resolve it properly
# and say what to do rather than failing with an opaque native-command error.
$here = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Get-Location).Path }
$target = Join-Path $here "install.mjs"
if (-not (Test-Path $target)) {
  $repoName = if ($env:MODELMESH_REPO) { $env:MODELMESH_REPO } else { "SehonYT/modelmesh" }
  throw "install.mjs not found next to this script (looked in '$here'). Run it from a clone, or use: irm https://raw.githubusercontent.com/$repoName/main/get.ps1 | iex"
}
& $Node $target @args
exit $LASTEXITCODE