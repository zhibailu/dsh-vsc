# Re-apply the dsh host.describe clientCount patch (idempotent).
# npm updates of @deepseek-ai/dsh overwrite these files; run this script after
# any dsh update to restore the client-count field the extension's shutdown
# logic depends on (deactivate reference-counting: kill only when we are the
# last client of an instance we spawned).
#
# Patch:
#  dsh-host-apiproxy/lib/index.js
#   - hostDescribeValueSchema gains `clientCount` (non-negative int)
#   - host.describe implementation reports `clientCount: muxQueues.size`
#     (muxQueues = live consumers of /api/events.mux: each browser tab and
#     each extension counts as one connection; the extension's own stream is
#     one of them).
#
# The schema must be patched together with the implementation: the response
# value is zod-validated (z.object strips unknown keys by default), so a
# clientCount returned without a schema entry would be silently dropped.
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

$api = Join-Path $root "dsh-host-apiproxy\lib\index.js"

# 1. response schema: add clientCount next to attachedSessions (LF line endings)
Apply-Patch $api "clientCount: z`$1.number().int().nonnegative()," `
  "	attachedSessions: z`$1.number().int().nonnegative(),`n" `
  "	attachedSessions: z`$1.number().int().nonnegative(),`n	clientCount: z`$1.number().int().nonnegative(),`n" `
  "host.describe schema clientCount"

# 2. implementation: report muxQueues.size (LF line endings, 5 tabs indentation)
Apply-Patch $api "clientCount: muxQueues.size," `
  "					attachedSessions: ctx.agents.list().length,`n" `
  "					attachedSessions: ctx.agents.list().length,`n					clientCount: muxQueues.size,`n" `
  "host.describe impl clientCount"

Write-Host "[done]"
