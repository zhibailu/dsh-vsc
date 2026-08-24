# Re-apply the dsh windowless-console patches (idempotent).
# npm updates of @deepseek-ai/dsh overwrite these files; run this script after
# any dsh update to restore windowless tool execution on Windows.
#
# Patches:
#  1. dsh-subprocess-local: spawn() gains windowsHide (local/pwsh tool path)
#  2. dsh-sandbox-windows-acl: restricted-token child console is created
#     hidden (STARTF_USESHOWWINDOW | SW_HIDE) instead of visible
$ErrorActionPreference = "Stop"
$root = "C:\Users\WihteDew\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"

function Apply-Patch([string]$file, [string]$needle, [string]$old, [string]$new, [string]$label) {
  if (-not (Test-Path $file)) { Write-Host "[skip] ${label}: file not found: $file"; return }
  $text = [System.IO.File]::ReadAllText($file)
  if ($text.Contains($needle)) { Write-Host "[ok]   ${label}: already applied"; return }
  if (-not $text.Contains($old)) { Write-Host "[FAIL] ${label}: anchor not found — file changed upstream, manual review needed"; return }
  $text = $text.Replace($old, $new)
  [System.IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[PATCH] ${label}: applied"
}

$sub = Join-Path $root "dsh-subprocess-local\lib\index.js"
Apply-Patch $sub "windowsHide: platform" `
  "		detached: platform !== `"win32`"`r`n	});" `
  "		detached: platform !== `"win32`",`r`n		windowsHide: platform === `"win32`"`r`n	});" `
  "subprocess-local windowsHide"

$acl = Join-Path $root "dsh-sandbox-windows-acl\lib\types-CNjZgO4h.js"
Apply-Patch $acl "wShowWindow: 0" `
  "		dwFlags: 256,`r`n		hStdInput" `
  "		dwFlags: 257,`r`n		wShowWindow: 0,`r`n		hStdInput" `
  "windows-acl hidden console (pipe path)"
Apply-Patch $acl "wShowWindow: 0" `
  "		dwFlags: 256,`r`n		hStdInput: stdIn,`r`n		hStdOutput: stdOut,`r`n		hStdError: stdErr" `
  "		dwFlags: 257,`r`n		wShowWindow: 0,`r`n		hStdInput: stdIn,`r`n		hStdOutput: stdOut,`r`n		hStdError: stdErr" `
  "windows-acl hidden console (inherit path)"

Write-Host "[done]"
