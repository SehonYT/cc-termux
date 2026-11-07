# cc-termux installer for Windows
$ErrorActionPreference = "Stop"

function Ensure-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $major = [int]((& node -p "process.versions.node.split('.')[0]"))
    if ($major -ge 18) { return "node" }
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $ver = if ($env:CC_NODE_VERSION) { $env:CC_NODE_VERSION } else { "v22.14.0" }
  $dir = Join-Path $HOME ".local\share\cc-termux\runtime"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $zip = Join-Path $env:TEMP ("node-" + [guid]::NewGuid().ToString("N") + ".zip")
  $url = "https://nodejs.org/dist/$ver/node-$ver-win-$arch.zip"
  Write-Host "cc-termux: downloading Node.js from $url" -ForegroundColor Cyan
  Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  Remove-Item $zip -Force
  return (Join-Path $dir "node-$ver-win-$arch\node.exe")
}

$Node = Ensure-Node
& $Node "$PSScriptRoot\install.mjs" @args
exit $LASTEXITCODE