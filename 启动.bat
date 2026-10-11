@echo off
title PDF to Word
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [Error] Node.js not found. Please install Node.js from https://nodejs.org first.
    pause
    exit /b 1
)

node server.js
pause
