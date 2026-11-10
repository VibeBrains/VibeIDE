# Запускает C:\build.ps1 под PowerShell 7 вне сеанса SSH: обрыв соединения иначе убивает сборку
# Процесс создаётся через CIM, поэтому он не входит в job object сеанса SSH
# Вызов: powershell -ExecutionPolicy Bypass -File C:\launch-build.ps1 -Tag vX.Y.Z
param([Parameter(Mandatory)][string]$Tag)
New-Item -ItemType Directory -Force C:\b | Out-Null
$cmd = '"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -Command "& C:\build.ps1 -Tag ' + $Tag + ' *> C:\b\build.log"'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
Write-Output ("pid=" + $r.ProcessId + " rc=" + $r.ReturnValue)
