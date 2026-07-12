@echo off
cd /d "%~dp0"
git add .
git commit -m "update %date% %time%"
git push
echo.
echo Done. Press any key to close.
pause > nul
