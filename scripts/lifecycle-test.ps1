# Self-heal lifecycle test: auto-start on empty port, respawn after kill.
# Always cleans up (dev host + spawned harness + test dirs), even on failure.
$ErrorActionPreference = "Continue"
$root = "D:\MyProject\dshsandbox"
$ud = Join-Path $root ".vscode-test"
$ext = Join-Path $root ".vscode-test-ext"
$port = 3088
$base = "http://127.0.0.1:$port"

function Probe-Port([int]$p) {
  try { $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop; return $c.OwningProcess } catch { return $null }
}

function Invoke-Api([string]$u) {
  try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 4; return "$($r.StatusCode)" } catch { return "ERR $($_.Exception.Message)" }
}

$hostProc = $null
try {
  # 0. clear any leftover test harness on the port (never the user's real one: that is on 3080)
  $left = Probe-Port $port
  if ($left) { Write-Host "[step] cleaning leftover test harness pid $left"; & taskkill /PID $left /T /F 2>&1 | Out-Null; Start-Sleep -Seconds 1 }

  # 1. clean test dirs, preconfigure the test profile to target our port
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $ud "User") | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $ud "User\settings.json"),
    '{"dshVsc.url": "http://127.0.0.1:3088", "dshVsc.autoStart": true}',
    (New-Object System.Text.UTF8Encoding($false))
  )

  # 2. make sure nothing listens on the test port
  $before = Probe-Port $port
  if ($before) { Write-Host "[FAIL] port $port still in use (pid $before)"; return }
  Write-Host "[step] test port $port free"

  # 3. install the freshly built vsix into the TEST extensions dir (dev host uses it)
  New-Item -ItemType Directory -Force -Path $ext | Out-Null
  $vsix = Join-Path $root "dsh-vsc\dsh-vsc-0.1.0.vsix"
  $code = "D:\Microsoft VS Code\bin\code.cmd"
  & $code --extensions-dir $ext --user-data-dir $ud --install-extension $vsix --force 2>&1 | Out-Null
  $installed = Get-ChildItem -Path $ext -Directory -ErrorAction SilentlyContinue | Where-Object Name -like "*dsh-vsc-*"
  if (-not $installed) { Write-Host "[FAIL] vsix not installed into test extensions dir"; return }
  Write-Host "[step] vsix installed: $($installed.Name)"

  # 4. launch dev host (with DSH_VSC_AUTOTEST so the sidebar/stream path runs)
  $env:DSH_VSC_AUTOTEST = "1"
  $args = @("--user-data-dir=$ud", "--extensions-dir=$ext", "--disable-updates", "--no-sandbox",
            "--disable-gpu", "--remote-debugging-port=9222", (Join-Path $root "dsh-vsc"))
  $hostProc = Start-Process -FilePath $code -ArgumentList $args -PassThru -WindowStyle Hidden
  Write-Host "[step] dev host pid $($hostProc.Id) launched; waiting for auto-start (up to 60s)"

  # 5. wait for the harness to come up on 3088
  $upAt = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Probe-Port $port) { $upAt = (Get-Date); Write-Host "[ok] harness UP after ~$($i+1)s - auto-start works"; break }
  }
  if (-not $upAt) { Write-Host "[FAIL] harness never came up on $port"; return }

  # 6. kill whatever listens on the port (the whole tree)
  $pid1 = Probe-Port $port
  Write-Host "[step] killing harness tree (listener pid $pid1)"
  & taskkill /PID $pid1 /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  $still = Probe-Port $port
  Write-Host "[step] after kill: listener = $still"

  # 7. wait for the watchdog to respawn (0.5s polling; note the new pid + elapsed)
  $respawnedAt = $null
  $newPid = $null
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    $p = Probe-Port $port
    if ($p) { $newPid = $p; $respawnedAt = (Get-Date); Write-Host "[ok] respawned after $([math]::Round($sw.Elapsed.TotalSeconds, 1))s (new listener pid $newPid)"; break }
  }
  if (-not $respawnedAt) { Write-Host "[FAIL] watchdog did NOT respawn the harness" }
  elseif ($newPid -eq $pid1) { Write-Host "[warn] same pid as before — suspicious" }
  else { Write-Host "[ok] new pid differs from killed pid ($pid1) — genuine respawn" }

  # 8. API smoke on the (re)spawned instance
  Write-Host "[step] GET / -> $(Invoke-Api $base)"

  # 9. dump the relevant exthost log lines (dev host logs live under its user-data-dir)
  Start-Sleep -Seconds 2
  $log = Get-ChildItem -Path (Join-Path $ud "logs"), (Join-Path $root "logs") -Recurse -Filter "1-DSH Bridge.log" -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($log) {
    Write-Host "--- exthost log ($($log.FullName)) tail ---"
    Get-Content $log.FullName -Tail 40
  } else {
    Write-Host "[warn] no DSH Bridge.log found"
  }
}
finally {
  # 10. cleanup ALWAYS: dev host, spawned harness, test dirs
  if ($hostProc) { & taskkill /PID $hostProc.Id /T /F 2>&1 | Out-Null }
  $last = Probe-Port $port
  if ($last) { & taskkill /PID $last /T /F 2>&1 | Out-Null; Write-Host "[cleanup] killed stray harness pid $last" }
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[done]"
}
