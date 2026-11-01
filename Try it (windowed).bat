@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
  echo Run Build.bat first.
  pause
  exit /b 1
)
call npx electron . --windowed
