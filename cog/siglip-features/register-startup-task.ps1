# Registers the SigLIP home embedder as an At-Startup task running as SYSTEM,
# so it comes up after a power-cut reboot WITHOUT anyone logging in.
#
# RUN AS ADMINISTRATOR:
#   Right-click this file -> "Run with PowerShell" (accept the UAC prompt), OR
#   open an elevated terminal (Win+X -> Terminal (Admin)) and run:
#     powershell -ExecutionPolicy Bypass -File "<path>\register-startup-task.ps1"
#
# Safe to re-run (idempotent: -Force replaces any existing task).

$ErrorActionPreference = "Stop"

# Re-launch self elevated if not already admin.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Not elevated — requesting admin (approve the UAC prompt)..."
  Start-Process powershell.exe -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`"" -Verb RunAs
  return
}

$bat = "C:\Users\ZachD\Documents\PopAlpha\popalpha\cog\siglip-features\start_home_server.bat"
$action    = New-ScheduledTaskAction -Execute $bat
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "PopAlpha SigLIP Home Embedder" `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$t = Get-ScheduledTask -TaskName "PopAlpha SigLIP Home Embedder"
Write-Host ("REGISTERED: {0} | State={1} | RunAs={2} | Trigger=AtStartup" -f `
  $t.TaskName, $t.State, $t.Principal.UserId)
Write-Host "Done. The embedder will now start on boot, before login."
Write-Host "Press Enter to close..."; [void](Read-Host)
