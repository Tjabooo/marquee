@echo off
rem Runs Marquee and restarts it if it exits. Output is appended to logs\marquee.log.
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
echo [%date% %time%] starting Marquee>> "logs\marquee.log"
node server.js >> "logs\marquee.log" 2>&1
echo [%date% %time%] Marquee stopped, restarting in 5 seconds>> "logs\marquee.log"
timeout /t 5 /nobreak > nul
goto loop
