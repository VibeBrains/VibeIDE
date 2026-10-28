# Состояние сборки в машине: процессы сборки, размер, время и хвост журнала C:\b\build.log
# Лежит файлом, а не строкой в кавычках двух оболочек: русская локаль ломает разбор такой строки
Get-Process node,esbuild,git,pwsh,ISCC -ErrorAction SilentlyContinue | Select-Object Name,Id,CPU,@{Name='MB';Expression={[int]($_.WS/1MB)}} | Format-Table -AutoSize | Out-String
(Get-Item C:\b\build.log).Length
(Get-Item C:\b\build.log).LastWriteTime
Get-Content C:\b\build.log -Tail 2
