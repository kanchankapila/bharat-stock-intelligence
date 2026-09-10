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
  Run from an elevated PowerShell if you want the boot trigger; the logon trigger alone works
  unelevated. Verify afterwards with:
      Get-ScheduledTask -TaskName 'bharat-pm2-resurrect'
  Remove with:
      Unregister-ScheduledTask -TaskName 'bharat-pm2-resurrect' -Confirm:$false
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'bharat-pm2-resurrect',
  [string]$RepoDir  = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

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

$triggers = @()
$triggers += New-ScheduledTaskTrigger -AtLogOn
try {
  # Boot trigger needs elevation; skip it gracefully rather than failing the whole install.
  $triggers += New-ScheduledTaskTrigger -AtStartup
} catch {
  Write-Warning "Could not add the at-startup trigger (needs elevation). Logon trigger only."
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Existing task found — replacing it."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
  -Description 'Bring the Bharat Stock Intelligence pm2 stack back up after a reboot or resume (AF-20260910-05).' | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName'." -ForegroundColor Green
Write-Host "IMPORTANT: run 'pm2 save' whenever you change which apps are running, so the dump this task restores stays current."
Write-Host "Test it now without rebooting:  Start-ScheduledTask -TaskName '$TaskName'"
