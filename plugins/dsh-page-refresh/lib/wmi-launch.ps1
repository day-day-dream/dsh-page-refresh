# wmi-launch.ps1 - launch a detached process that survives the caller's death.
#
# NOTE: pure ASCII only. A .ps1 without a BOM is read as ANSI by Windows
# PowerShell, so non-ASCII comments corrupt the parse.
#
# Why this file exists (issue #1 follow-up, 2026-10-29):
#   The naive approach - Node's spawn(..., { detached: true }) - does NOT work on
#   this machine. Measured matrix (6 configurations, 3 repeats each):
#       detached:true  + stdio:'ignore'   -> child never runs
#       detached:true  + stdio:'inherit'  -> child never runs
#       detached:true  + stdio:['ignore','pipe','pipe'] -> child never runs
#       detached:false (any stdio)        -> child runs fine
#   Cause: the Electron host runs inside a Windows job object. spawn's "detached"
#   only creates a new process group; the child stays in the job and is torn down
#   with the parent. Background: this same trap is documented in the local notes
#   for CDP Edge ("never use `start`, else the job object kills it").
#
#   WMI's Win32_Process.Create is the way out: it asks the WMI service (a different
#   process tree entirely) to create the child, so the new process is NOT in our
#   job object and outlives us. Verified on this machine: ReturnValue 0 and the
#   target script actually ran and wrote its log.
#
# Usage: wmi-launch.ps1 -Exe <path> -Args <string> [-WorkDir <path>]
# Exit codes: 0 launched / 5 bad arguments / 6 WMI creation failed
param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [string]$Args = '',
  [string]$WorkDir = ''
)

$ErrorActionPreference = 'Continue'

if (-not $Exe) { exit 5 }
if (-not (Test-Path $Exe)) {
  # Host passes an absolute path. This fallback also accepts a bare command name
  # (e.g. "powershell.exe") so the launcher can be exercised by hand.
  $resolved = $null
  try { $resolved = (Get-Command $Exe -ErrorAction SilentlyContinue).Source } catch { }
  if (-not $resolved) {
    [Console]::Out.WriteLine('wmi-launch: exe not found: ' + $Exe)
    exit 5
  }
  $Exe = $resolved
}

# Build the command line. The exe path is quoted; the argument string is passed
# through verbatim (the caller already composed it with any quoting it needs).
$cmdline = '"' + $Exe + '"'
if ($Args) { $cmdline = $cmdline + ' ' + $Args }

$out = [Console]::Out
$out.WriteLine('wmi-launch: exe=' + $Exe)
$out.WriteLine('wmi-launch: args=' + $Args)
$out.WriteLine('wmi-launch: workdir=' + $WorkDir)
$out.WriteLine('wmi-launch: cmdline=' + $cmdline)

# Win32_Process.Create has no working-directory parameter, so when one is needed
# we wrap with `cmd /c cd /d <dir> && <cmdline>`. Only do that if asked.
$finalCmd = $cmdline
if ($WorkDir -and (Test-Path $WorkDir)) {
  $finalCmd = 'cmd.exe /c cd /d "' + $WorkDir + '" && ' + $cmdline
  $out.WriteLine('wmi-launch: wrapped for workdir')
}

try {
  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $finalCmd } -ErrorAction Stop
} catch {
  $out.WriteLine('wmi-launch: EXCEPTION ' + $_.Exception.Message)
  exit 6
}

$out.WriteLine('wmi-launch: return=' + [string]$res.ReturnValue + ' pid=' + [string]$res.ProcessId)
if ($res.ReturnValue -eq 0 -and $res.ProcessId) {
  exit 0
}
exit 6