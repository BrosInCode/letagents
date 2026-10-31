(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'Start-Sleep 240' } | Measure-Object).Count
Test-Path C:\Users\emmyleke\AppData\Local\Temp\prl-survive.txt
