@echo off
rem MuseDungeon: double-click to start the server and open the game in your browser.
rem The steps are in packages\server\bin\muse-launch.mjs (Node.js 22 or later is required).
rem Closing this window stops the server.
cd /d "%~dp0"
title MuseDungeon
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node "packages\server\bin\muse-launch.mjs"
if errorlevel 1 pause
