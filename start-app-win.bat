@echo off
setlocal EnableDelayedExpansion

:: PDF Presenter - App Starter
:: This script launches the PDF Presenter application

title PDF Presenter - Starter

echo ==========================================
echo    Starting PDF Presenter...
echo ==========================================
echo.

set "APP_NAME=PDF Presenter"
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] Dependencies not found. Please run windows-install.bat first.
    pause
    exit /b 1
)

echo The server prints its local and network URLs below.
echo.
echo Press Ctrl+C to stop the server
echo.
echo [INFO] Launching %APP_NAME%...

:: Launch the app
call npm start

:: If npm start fails, pause to show error
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Application exited with error
    pause
)

exit /b 0
