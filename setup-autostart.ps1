# Run this from INSIDE the signshop-dashboard folder, in PowerShell as Administrator.
# Right-click PowerShell -> "Run as administrator", then cd to the folder, then run this script.

$ProjectPath = (Get-Location).Path

$PythonExe = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $PythonExe) { $PythonExe = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
if (-not $PythonExe) {
    Write-Host "Could not find python.exe or pythonw.exe on PATH. Install Python or fix PATH first." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "$ProjectPath\app.py")) {
    Write-Host "app.py not found in current folder ($ProjectPath). cd into the signshop-dashboard folder first." -ForegroundColor Red
    exit 1
}

# Scheduled task: runs the dashboard automatically every time you log in
$Action = New-ScheduledTaskAction -Execute $PythonExe -Argument "app.py" -WorkingDirectory $ProjectPath
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "SignShopDashboard" -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "Runs the production dashboard Flask app at login" -Force | Out-Null
Write-Host "Scheduled task created: will auto-start the dashboard every login." -ForegroundColor Green

# Firewall: allow inbound traffic on port 5000 (needed for Tailscale access from other devices)
New-NetFirewallRule -DisplayName "SignShop Dashboard" -Direction Inbound -LocalPort 5000 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
Write-Host "Firewall rule added for port 5000." -ForegroundColor Green

# Start it right now too, so it's live tonight without a reboot
Start-ScheduledTask -TaskName "SignShopDashboard"
Start-Sleep -Seconds 2

$tsIp = & tailscale ip -4 2>$null
Write-Host ""
Write-Host "Done. The dashboard should be running now." -ForegroundColor Cyan
Write-Host "Test locally at: http://localhost:5000"
if ($tsIp) {
    Write-Host "From your phone/laptop over Tailscale: http://$($tsIp):5000"
} else {
    Write-Host "Run 'tailscale ip -4' to get your Tailscale address for remote access."
}
