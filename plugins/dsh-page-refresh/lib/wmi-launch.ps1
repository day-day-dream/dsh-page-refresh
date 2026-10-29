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

# Pass a Win32_ProcessStartup so the child gets NO VISIBLE console.
#
# Why this matters (reported by david-zdw against v1.2.0, reproduced and fixed here):
#   without startup information the WMI-created powershell comes up with a VISIBLE
#   console window; dsh-power.ps1 then launched the new DSH as a child of it, so
#   closing that window sent CTRL_CLOSE and took DSH down with it.
#
# Alternatives that do NOT work on Windows PowerShell 5.1 (all measured):
#   CreateFlags 0x08000000 (CREATE_NO_WINDOW)  -> Create returns 21 (invalid params)
#   CreateFlags 0x00000008 (DETACHED_PROCESS)  -> process exists but the script never
#     runs: PowerShell 5.1 cannot start its ConsoleHost without a console, so
#     dsh-power.ps1's "start action=..." line never appears.
# ShowWindow = 0 keeps the console object (script runs fine) but never shows it.
$startup = $null
try {
  $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $startup.ShowWindow = [uint16]0
} catch {
  $out.WriteLine('wmi-launch: startup object unavailable: ' + $_.Exception.Message)
  $startup = $null
}

$res = $null
try {
  if ($startup -ne $null) {
    $res = ([wmiclass]'Win32_Process').Create($finalCmd, $null, $startup)
  } else {
    $res = ([wmiclass]'Win32_Process').Create($finalCmd)
  }
} catch {
  # Never let the startup object be the reason a restart fails: fall back to the
  # parameterless CIM call that v1.2.0 shipped with (visible console, but works).
  $out.WriteLine('wmi-launch: wmiclass path failed: ' + $_.Exception.Message)
  try {
    $cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $finalCmd } -ErrorAction Stop
    $res = [PSCustomObject]@{ ReturnValue = $cim.ReturnValue; ProcessId = $cim.ProcessId }
    $out.WriteLine('wmi-launch: fell back to Invoke-CimMethod (console will be visible)')
  } catch {
    $out.WriteLine('wmi-launch: FALLBACK FAILED ' + $_.Exception.Message)
    exit 6
  }
}

$out.WriteLine('wmi-launch: return=' + [string]$res.ReturnValue + ' pid=' + [string]$res.ProcessId + ' hidden=' + [string]($startup -ne $null))
if ($res.ReturnValue -eq 0 -and $res.ProcessId) {
  exit 0
}
exit 6