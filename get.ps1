# modelmesh bootstrap installer for Windows: irm .../get.ps1 | iex
# Env: MODELMESH_REPO, MODELMESH_REF, MODELMESH_ARCHIVE (offline tarball).
$ErrorActionPreference = "Stop"

$Repo = if ($env:MODELMESH_REPO) { $env:MODELMESH_REPO } else { "SehonYT/modelmesh" }
$Ref = if ($env:MODELMESH_REF) { $env:MODELMESH_REF } else { "main" }

function Ensure-Node {
  $Node = Get-Command node -ErrorAction SilentlyContinue
  if ($Node) {
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

$Tmp = Join-Path $env:TEMP ("modelmesh-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  $Archive = Join-Path $Tmp "src.tar.gz"
  if ($env:MODELMESH_ARCHIVE) {
    Copy-Item $env:MODELMESH_ARCHIVE $Archive
  } else {
    $Sha = ""
    $Date = ""
    try {
      if ($Ref -eq "main") {
        # The newest commit whose tests passed, not the tip of main: a commit that failed ci
        # must never be installed by default. MODELMESH_REF=main opts into bleeding edge.
        $feed = "verified"
        try {
          $atom = (Invoke-WebRequest "https://github.com/$Repo/commits/verified.atom" -UseBasicParsing -TimeoutSec 20).Content
        } catch {
          $atom = ""
        }
        $m = [regex]::Match($atom, "Grit::Commit/([0-9a-f]{40})")
        if (-not $m.Success) {
          Write-Host "modelmesh: no verified commit yet; falling back to main (untested)" -ForegroundColor Yellow
          $feed = "main"
          $atom = (Invoke-WebRequest "https://github.com/$Repo/commits/main.atom" -UseBasicParsing -TimeoutSec 20).Content
          $m = [regex]::Match($atom, "Grit::Commit/([0-9a-f]{40})")
        }
        if ($m.Success) {
          $Sha = $m.Groups[1].Value
          $d = [regex]::Match($atom, "<updated>([^<]+)</updated>")
          if ($d.Success) { $Date = $d.Groups[1].Value }
        }
      } else {
        $api = (Invoke-WebRequest "https://api.github.com/repos/$Repo/commits/$Ref" -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
        $Sha = $api.sha
        $Date = $api.commit.committer.date
      }
      if ($Sha) { $env:MODELMESH_COMMIT_SHA = $Sha }
      if ($Date) { $env:MODELMESH_COMMIT_DATE = $Date }
    } catch { }
    $archiveRef = if ($Sha) { $Sha } else { $Ref }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        Invoke-WebRequest "https://codeload.github.com/$Repo/tar.gz/$archiveRef" -OutFile $Archive -UseBasicParsing -TimeoutSec 900
        break
      } catch {
        if ($attempt -eq 3) { throw }
        Write-Host "  download failed (attempt $attempt/3), retrying..." -ForegroundColor DarkGray
        Start-Sleep -Seconds (2 * $attempt)
      }
    }
  }
  $Src = Join-Path $Tmp "src"
  New-Item -ItemType Directory -Path $Src | Out-Null
  tar -xzf $Archive -C $Src
  $Install = Get-ChildItem -Path $Src -Filter install.mjs -Recurse -Depth 1 | Select-Object -First 1
  if (-not $Install) { throw "install.mjs not found in archive" }
  & $Node $Install.FullName @args
  exit $LASTEXITCODE
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}