@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem Piano ear game launcher. Keep this file UTF-8 encoded.
set "APP_DIR=%~dp0"
set "APP_PORT=8128"
set "APP_MARKER=piano-ear-game-http-server"

echo Stopping the existing %APP_MARKER% on port %APP_PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %APP_PORT%; $marker = '%APP_MARKER%'; $root = [IO.Path]::GetFullPath('%APP_DIR%'); Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess) -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like ('*' + $marker + '*') -and $p.CommandLine -like ('*' + $root + '*')) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }"

echo Starting the local server from "%APP_DIR%"...
pushd "%APP_DIR%"
start "%APP_MARKER%" /b python -c "import http.server; http.server.ThreadingHTTPServer(('127.0.0.1',%APP_PORT%),http.server.SimpleHTTPRequestHandler).serve_forever()" %APP_MARKER% "%APP_DIR%"
popd

timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:%APP_PORT%/index.html"
echo Piano ear game: http://127.0.0.1:%APP_PORT%/index.html
endlocal
