# dsh-power.ps1 - restart / close the DSH desktop app, portable across machines.
#
# NOTE: this file must stay pure ASCII. Windows PowerShell reads a .ps1 without a
# BOM as ANSI, so non-ASCII comments corrupt the parse (hit this on 2026-10-23:
# a Chinese comment line ate the following code block).
#
# Why a script instead of plain taskkill:
#   * Restart must re-launch the app the SAME way it was launched, otherwise the
#     new instance loses --user-data-dir / custom flags. The original command line
#     is read from the live main process before killing it.
#   * The main process is the one whose command line has NO '--type=' switch:
#     renderer / gpu-process / utility children all carry --type=..., so filtering
#     those out leaves exactly the app entry point.
#
# Actions:
#   restart - kill, then relaunch with the same exe + arguments + working dir
#   close   - kill only
#   probe   - print what restart would use, change nothing (for verification)
#
# Exit codes: 0 ok / 2 no running DSH desktop process / 3 relaunch failed.
param([ValidateSet('restart', 'close', 'probe')][string]$Action = 'restart')

$ErrorActionPreference = 'SilentlyContinue'

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
if (-not $main) { exit 2 }

$exePath = $main.ExecutablePath
$fullCmd = $main.CommandLine

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
  $mainCount = ($all | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }).Count
  [Console]::Out.WriteLine('probe: exe=' + $exePath)
  [Console]::Out.WriteLine('probe: args=' + $restArgs)
  [Console]::Out.WriteLine('probe: allProcesses=' + $all.Count + ' mainProcesses=' + $mainCount)
  exit 0
}

foreach ($p in Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'") {
  Stop-Process -Id $p.ProcessId -Force
}

if ($Action -ne 'restart') { exit 0 }
if (-not $exePath) { exit 3 }

# Let the old instance release its handles and single-instance lock.
Start-Sleep -Seconds 3

$workDir = Split-Path -Parent $exePath
if ($restArgs) {
  Start-Process -FilePath $exePath -ArgumentList $restArgs -WorkingDirectory $workDir
} else {
  Start-Process -FilePath $exePath -WorkingDirectory $workDir
}

exit 0