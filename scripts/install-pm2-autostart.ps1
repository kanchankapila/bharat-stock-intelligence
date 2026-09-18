<#
.SYNOPSIS
  Register a Scheduled Task that brings the pm2 stack back after a reboot or resume.

.DESCRIPTION
  AF-20260910-05. This box runs the whole platform under pm2, but pm2 has no Windows service
  and `pm2 startup` does not support Windows -- so after every reboot the platform stays down
  until a human runs pm2 by hand. Measured 2026-09-10 over the trailing 14 days: NINE windows
  longer than 2h in which not a single job of any kind ran (~40h total), the largest 8.6h.
  The most recent was a planned Windows Update restart (System event 1074, TrustedInstaller,
  02:06 IST) that left the platform down 4.4h and killed an in-flight ml-weekly-retrain.

  This registers a task that runs `pm2 resurrect` (falling back to the ecosystem file when no
  dump exists) at logon and on wake, which is the right trigger set for a laptop that sleeps.

  Idempotent: re-running replaces the existing task.

.NOTES
  RUN THIS FROM AN ELEVATED POWERSHELL. Measured on this box 2026-09-10: Task Scheduler
  refuses `Register-ScheduledTask` unelevated for ANY trigger set, not just the boot trigger,
  so the logon-only fallback below is denied too. The fallback is still worth having (it
  degrades with a clear message instead of a raw CimException, and works where only the boot
  trigger is privileged), but it cannot rescue an unelevated run here. The pre-2026-09-10
  version promised "the logon trigger alone works unelevated" and guarded the wrong statement
  -- the try/catch wrapped the trigger CONSTRUCTION, which never throws. Verify afterwards
  with:
      Get-ScheduledTask -TaskName 'bharat-pm2-resurrect'
  Remove with:
      Unregister-ScheduledTask -TaskName 'bharat-pm2-resurrect' -Confirm:$false
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'bharat-pm2-resurrect',
  [string]$RepoDir
)

$ErrorActionPreference = 'Stop'

# Resolved in the body, not as a param default: under `powershell.exe -File`, $PSScriptRoot is
# not yet populated while parameter defaults are being bound, so the default form threw
# "Cannot bind argument to parameter 'Path' because it is an empty string" before this script
# had ever run. $MyInvocation.MyCommand.Path is the fallback that works when dot-sourced too.
if (-not $RepoDir) {
  $here = $PSScriptRoot
  if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $RepoDir = Split-Path -Parent $here
}

$pm2 = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $pm2) { throw "pm2 not found on PATH. Install it (npm i -g pm2) or run this from a shell where pm2 resolves." }

# pm2 on Windows is a .cmd shim; Scheduled Tasks must invoke it through cmd.exe.
# `pm2 resurrect` restores the saved process list (dump.pm2, refreshed by `pm2 save`).
# If no dump exists yet, fall back to the repo's own ecosystem file, which is the source of truth.
$dump = Join-Path $env:USERPROFILE '.pm2\dump.pm2'
$inner = if (Test-Path $dump) {
  "pm2 resurrect"
} else {
  "pm2 start `"$RepoDir\ecosystem.config.cjs`""
}
$command = "cd /d `"$RepoDir`" && $inner"

Write-Host "Repo dir : $RepoDir"
Write-Host "pm2      : $pm2"
Write-Host "Command  : $command"

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $command"

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
# 2026-09-10: the boot trigger's elevation fallback NEVER fired. It used to wrap
# `New-ScheduledTaskTrigger -AtStartup` in a try/catch -- but constructing that trigger object
# succeeds unelevated; it is `Register-ScheduledTask` (further down, OUTSIDE the catch) that
# throws "Access is denied." So the script always included the boot trigger and always failed
# unelevated with a raw CimException, while its own NOTES promised "the logon trigger alone
# works unelevated". Measured on this box: unelevated install failed outright.
# The retry now sits where the privilege is actually exercised.
$triggers = @($logonTrigger, (New-ScheduledTaskTrigger -AtStartup))

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Existing task found -- replacing it."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$desc = 'Bring the Bharat Stock Intelligence pm2 stack back up after a reboot or resume (AF-20260910-05).'
$registered = $false
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Description $desc -ErrorAction Stop | Out-Null
  $registered = $true
  $triggerNote = 'logon + startup'
} catch {
  # Only the STARTUP trigger needs elevation. Falling back to logon-only still covers the
  # dominant case on a laptop that sleeps, and a partial install beats no install -- the
  # alternative was leaving the platform with no autostart at all until someone found an
  # admin shell.
  Write-Warning "Could not register with the at-startup trigger (needs elevation): $($_.Exception.Message)"
  Write-Warning "Retrying with the logon trigger only."
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $logonTrigger `
      -Settings $settings -Description $desc -ErrorAction Stop | Out-Null
    $registered = $true
    $triggerNote = 'logon ONLY -- re-run this script from an ELEVATED PowerShell to add the boot trigger'
  } catch {
    # Third rung, and the only one that needs NO privilege. This box refuses
    # Register-ScheduledTask unelevated for ANY trigger set (measured 2026-09-10), and until
    # 2026-09-18 this retry sat outside any try -- so the script died here and NOTHING was
    # installed. That went unnoticed for 8 days because AF-20260917-14's clean-uptime streak was
    # credited to this script "having taken effect"; on 2026-09-18 Get-ScheduledTask showed no
    # task at all and the Startup folder held nothing. The streak was the host simply not
    # rebooting (last boot 2026-09-13 15:46, restarted by hand 3.5 min later).
    # The per-user Startup folder runs at LOGON with no elevation. Weaker than a boot trigger (a
    # reboot that nobody logs in to will not start the platform), but it is real, and a partial
    # install beats a script that exits having installed nothing.
    Write-Warning "Logon-trigger registration was ALSO refused: $($_.Exception.Message)"
    Write-Warning "Falling back to the per-user Startup folder (no elevation needed)."
    $startup = [Environment]::GetFolderPath('Startup')
    $cmdPath = Join-Path $startup "$TaskName.cmd"
    Set-Content -Path $cmdPath -Encoding ascii -Value "@echo off`r`n$command`r`n"
    $registered = $true
    $triggerNote = "Startup-folder script at $cmdPath (LOGON only; re-run ELEVATED for a boot trigger)"
  }
}

Write-Host ""
Write-Host "Registered '$TaskName' ($triggerNote)." -ForegroundColor Green
Write-Host "IMPORTANT: run 'pm2 save' whenever you change which apps are running, so the dump this task restores stays current."
Write-Host "Test it now without rebooting:  Start-ScheduledTask -TaskName '$TaskName'  (or run the Startup-folder .cmd directly)"
