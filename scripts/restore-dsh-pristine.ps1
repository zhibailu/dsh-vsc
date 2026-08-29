# restore-dsh-pristine.ps1  [-VerifyOnly]
#
# Restore the official @deepseek-ai/dsh installation to the byte-exact npm
# registry release (v0.1.1-rc.1), reverting any disk patches that older
# dsh-vsc versions applied (scripts/patch-dsh-*.ps1 — now REMOVED).
#
# The extension now applies these deltas at RUNTIME as a per-process ESM
# loader overlay (src/harness/overlay/), so the installed tree must stay
# pristine ("pure bridge": never write DSH official files).
#
# What it reverts (same 4 deltas the old scripts applied, in reverse):
#   1. dsh-host-apiproxy/lib/index.js     host.describe schema + impl clientCount
#   2. dsh-subprocess-local/lib/index.js  spawn windowsHide
#   3. dsh-sandbox-windows-acl/lib/types-*.js  hidden console (2 sites)
#
# Every restored file is verified against the recorded pristine SHA256.
# -VerifyOnly: check only, never write (exit 1 if any file is not pristine).
$ErrorActionPreference = "Stop"

$VerifyOnly = $args -contains "-VerifyOnly"
$dshRoot = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh"
$subRoot = Join-Path $dshRoot "node_modules\@deepseek-ai"
$expectedDshVersion = "0.1.1-rc.1"

# relative path under $subRoot -> pristine SHA256 of the npm release file
$pristine = @{
  "dsh-host-apiproxy\lib\index.js"          = "B37CD0EED0A20D625788608374C51B50AD367A8B42EB4D484F3542DB18114EC9"
  "dsh-subprocess-local\lib\index.js"       = "F3A11B8AD2D3E01CA9943E9EC919465D8D4525E60FDD6904DA0D4494FE00C247"
  "dsh-sandbox-windows-acl\lib\types-CNjZgO4h.js" = "D75087768CC528FEC521C8E93259FF3B37A9FB4D3C627F132EA76F23FB4B4F54"
}

function Get-Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash
}

$changed = 0
$failed = 0

foreach ($rel in $pristine.Keys) {
  $file = Join-Path $subRoot $rel
  $label = $rel
  if (-not (Test-Path $file)) {
    Write-Host "[skip] $label : file not found: $file"
    continue
  }

  $hashNow = Get-Sha256 $file
  if ($hashNow -eq $pristine[$rel]) {
    Write-Host "[ok]   $label : already pristine ($hashNow)"
    continue
  }

  if ($VerifyOnly) {
    Write-Host "[FAIL] $label : NOT pristine (sha256 $hashNow)" -ForegroundColor Red
    $failed++
    continue
  }

  $text = [System.IO.File]::ReadAllText($file)
  $before = $text

  switch -Regex ($rel) {
    "dsh-host-apiproxy" {
      # 1a. schema: drop the clientCount zod line next to attachedSessions
      $text = [regex]::Replace($text, '\tclientCount: z\$1\.number\(\)\.int\(\)\.nonnegative\(\),\r?\n', '')
      # 1b. impl: drop the clientCount muxQueues.size line next to attachedSessions
      $text = [regex]::Replace($text, '\t\t\t\t\tclientCount: muxQueues\.size,\r?\n', '')
    }
    "dsh-subprocess-local" {
      # 2. spawn options: remove the injected comma + windowsHide line
      $text = [regex]::Replace($text, ',\r?\n\t\twindowsHide: platform === "win32"', '')
    }
    "dsh-sandbox-windows-acl" {
      # 3. both STARTUPINFO sites: dwFlags 257 + wShowWindow 0 -> dwFlags 256
      $text = [regex]::Replace($text, '(\t\tdwFlags: 257,)(\r?\n)(\t\twShowWindow: 0,)(\r?\n)', {
        param($m)
        "`t`tdwFlags: 256," + $m.Groups[2].Value
      })
    }
  }

  if ($text -eq $before) {
    Write-Host "[FAIL] $label : patched markers not found for reversal — manual review needed" -ForegroundColor Red
    $failed++
    continue
  }

  [System.IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding($false)))
  $hashAfter = Get-Sha256 $file
  if ($hashAfter -eq $pristine[$rel]) {
    Write-Host "[RESTORED] $label : byte-identical to npm release ($hashAfter)"
    $changed++
  } else {
    Write-Host "[FAIL] $label : post-restore sha256 mismatch ($hashAfter)" -ForegroundColor Red
    $failed++
  }
}

# version sanity
$pkg = Join-Path $dshRoot "package.json"
if (Test-Path $pkg) {
  $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version
  if ($ver -ne $expectedDshVersion) {
    Write-Host "[warn] installed @deepseek-ai/dsh is $ver ; pristine hashes recorded for $expectedDshVersion — upgrade checkpoints in internal/runtime-overlay.md" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "summary: $changed restored, $failed failed, remaining files pristine-checked"
if ($failed -gt 0) { exit 1 }
if ($changed -gt 0) { Write-Host "official DSH body is now pristine — the runtime overlay (src/harness/overlay) provides the patches in-memory" }
