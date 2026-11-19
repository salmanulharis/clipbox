@echo off
rem Runs the ClipBox server and restarts it if it ever exits.
rem Started hidden at logon by clipbox-hidden.vbs (see install-autostart.ps1).
setlocal
cd /d "%~dp0..\.."
set "ROOT=%CD%"
if not exist "%ROOT%\data" mkdir "%ROOT%\data"

:loop
rem Keep the log small: rotate at ~5 MB.
for %%A in ("%ROOT%\data\clipbox.log") do if %%~zA GTR 5000000 move /y "%ROOT%\data\clipbox.log" "%ROOT%\data\clipbox.log.1" >nul
echo [%date% %time%] starting ClipBox>> "%ROOT%\data\clipbox.log"
node "%ROOT%\server\index.js" >> "%ROOT%\data\clipbox.log" 2>&1
echo [%date% %time%] ClipBox exited with code %errorlevel%, restarting in 5 s>> "%ROOT%\data\clipbox.log"
timeout /t 5 /nobreak >nul
goto loop
