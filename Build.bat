@echo off
title Couch Launcher - Build
cd /d "%~dp0"
echo.
echo  Couch Launcher - building the app
echo  =================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Get the LTS version from https://nodejs.org
  echo  then run this file again.
  echo.
  pause
  exit /b 1
)
echo  [1/3] Downloading what the app needs ^(first time only^)...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed
echo.
echo  [2/3] Finishing setup...
rem Newer npm versions can skip setup steps for packages; run them directly to be sure.
if not exist "node_modules\electron\dist\electron.exe" (
  pushd node_modules\electron
  call node install.js
  popd
)
pushd node_modules\koffi
call node src\cnoke\cnoke.js -P . -D src\koffi --prebuild >nul 2>nul
popd
echo.
echo  [3/3] Building Couch Launcher.exe ...
call npm run dist
if errorlevel 1 goto failed
echo.
echo  Done! Your installer and portable .exe are in the "dist" folder.
start "" "%~dp0dist"
pause
exit /b 0
:failed
echo.
echo  Something went wrong. Scroll up to see the error.
pause
exit /b 1
