# dsh-power.ps1 - restart / close the DSH desktop app, portable across machines.
#
# NOTE: this file must stay pure ASCII. Windows PowerShell reads a .ps1 without a
# BOM as ANSI, so non-ASCII comments corrupt the parse (hit this on 2026-10-23:
# a Chinese comment line ate the following code block).
#
# Revised 2026-10-29 for issue #1
# (https://github.com/day-day-dream/dsh-page-refresh/issues/1). Four fixes:
#
#   1. ELECTRON_RUN_AS_NODE is now stripped before relaunching. This was the real
#      cause of "clicked restart, nothing happened": the desktop shell starts the
#      host half with ELECTRON_RUN_AS_NODE=1, our spawn inherits it, Start-Process
#      inherits it again, and the new "app" comes up in Node mode with no window.
#      @luoshuizhiwei/dsh-desktop-restart deletes it for the same reason.
#   2. Every step is appended to <DSH_HOME>\logs\page-refresh-restart.log.
#   3. Start-Process result is verified - a new main process must appear, else we
#      exit 4. "Spawned the process" is not the same as "restart succeeded".
#   4. Errors are captured per-step instead of being swallowed by
#      $ErrorActionPreference = 'SilentlyContinue'.
#
# Why a script instead of plain taskkill:
#   * Restart must re-launch the app the SAME way it was launched, otherwise the
#     new instance loses --user-data-dir / custom flags. The original command line
#     is read from the live main process before killing it.
#   * The main process is the one whose parent is NOT itself a DSH process.
#
# Actions:
#   restart - kill, then relaunch with the same exe + arguments + working dir
#   close   - kill only
#   probe   - print what restart would use, change nothing (for verification)
#
# Exit codes: 0 ok / 2 no running DSH desktop process / 3 relaunch failed
#             / 4 new instance did not appear within the wait window
param([ValidateSet('restart', 'close', 'probe')][string]$Action = 'restart')

$ErrorActionPreference = 'Continue'   # we log each failure ourselves; do not stop dead

# ---------- logging ----------
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$LogDir = Join-Path $DshHome 'logs'
$LogFile = Join-Path $LogDir 'page-refresh-restart.log'

function Write-Log([string]$Tag, [string]$Msg) {
  $line = '[' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + '] ' + $Tag + ' ' + $Msg
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
  [Console]::Out.WriteLine($line)
}

Write-Log 'start' ('action=' + $Action + ' pid=' + $PID + ' user=' + $env:USERNAME)

# ---------- find the app entry point ----------
function Get-DshMainProcess {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'")
  if ($all.Count -eq 0) { return $null }
  # Entry point = the process whose parent is NOT itself a DeepSeek Harness process.
  # Filtering on "no --type= in the command line" alone is not enough: measured on
  # this machine it left 3 candidates (crashpad_handler and friends carry no --type=),
  # so Select-First-1 could have picked a side process and relaunched the app with
  # the wrong exe path / arguments.
  $ids = @($all | ForEach-Object { $_.ProcessId })
  $roots = @($all | Where-Object { $ids -notcontains $_.ParentProcessId })
  if ($roots.Count -ge 1) { return $roots[0] }
  return $all[0]
}

$main = Get-DshMainProcess
if (-not $main) {
  Write-Log 'abort' 'no "DeepSeek Harness.exe" process found'
  exit 2
}

$exePath = $main.ExecutablePath
$fullCmd = $main.CommandLine
$mainPid = $main.ProcessId
Write-Log 'found' ('pid=' + $mainPid + ' exe=' + $exePath)
Write-Log 'cmdline' ([string]$fullCmd)

# Everything after the quoted exe path is the original argument string.
$restArgs = ''
if ($fullCmd) {
  $trimmed = $fullCmd.Trim()
  if ($trimmed.StartsWith('"')) {
    $closeQuote = $trimmed.IndexOf('"', 1)
    if ($closeQuote -gt 0) { $restArgs = $trimmed.Substring($closeQuote + 1).Trim() }
  } else {
    $sp = $trimmed.IndexOf(' ')
    if ($sp -gt 0) { $restArgs = $trimmed.Substring($sp + 1).Trim() }
  }
}

# probe: report only, so the portable path can be verified without killing DSH.
if ($Action -eq 'probe') {
  $all = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'"
  $mainCount = @($all | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }).Count
  [Console]::Out.WriteLine('probe: exe=' + $exePath)
  [Console]::Out.WriteLine('probe: args=' + $restArgs)
  [Console]::Out.WriteLine('probe: allProcesses=' + $all.Count + ' mainProcesses=' + $mainCount)
  [Console]::Out.WriteLine('probe: electronRunAsNode=' + [string]$env:ELECTRON_RUN_AS_NODE)
  Write-Log 'probe' ('exe=' + $exePath + ' mainProcesses=' + $mainCount + ' electronRunAsNode=' + [string]$env:ELECTRON_RUN_AS_NODE)
  exit 0
}

# ---------- kill ----------
$killed = 0
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'") {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    $killed++
  } catch {
    Write-Log 'kill-failed' ('pid=' + $p.ProcessId + ' err=' + $_.Exception.Message)
  }
}
Write-Log 'killed' ('count=' + $killed)

if ($Action -ne 'restart') {
  Write-Log 'done' 'close only'
  exit 0
}
if (-not $exePath) {
  Write-Log 'abort' 'no ExecutablePath for main process'
  exit 3
}

# Let the old instance release its handles and single-instance lock.
Start-Sleep -Seconds 3

# ---------- relaunch (with the environment fix) ----------
# Strip the two variables that would turn the new instance into a headless Node
# process. This is the fix for issue #1 - do not remove these lines.
$stripped = @()
foreach ($name in @('ELECTRON_RUN_AS_NODE', 'DSH_DESKTOP_NODE_EXECUTABLE')) {
  $cur = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($cur) {
    $stripped += $name
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
}
Write-Log 'env' ('stripped=' + (($stripped | ForEach-Object { $_ }) -join ',') + ' electronRunAsNodeNow=' + [string]$env:ELECTRON_RUN_AS_NODE)

$before = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'").Count
$workDir = Split-Path -Parent $exePath
try {
  if ($restArgs) {
    Start-Process -FilePath $exePath -ArgumentList $restArgs -WorkingDirectory $workDir -ErrorAction Stop
  } else {
    Start-Process -FilePath $exePath -WorkingDirectory $workDir -ErrorAction Stop
  }
  Write-Log 'relaunch' ('exe=' + $exePath + ' args=' + $restArgs + ' workdir=' + $workDir)
} catch {
  Write-Log 'relaunch-failed' $_.Exception.Message
  exit 3
}

# ---------- verify the new instance actually came up ----------
# "Start-Process returned" only means the OS accepted the launch request.
$deadline = (Get-Date).AddSeconds(20)
$alive = 0
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $alive = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'").Count
  if ($alive -gt 0) { break }
}
if ($alive -gt 0) {
  Write-Log 'verify-ok' ('processes=' + $alive + ' (before=' + $before + ')')
  exit 0
}
Write-Log 'verify-failed' ('no "DeepSeek Harness.exe" process appeared within 20s (before=' + $before + ')')
exit 4