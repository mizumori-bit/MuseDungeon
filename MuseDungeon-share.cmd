@echo off
rem MuseDungeon (share): like MuseDungeon.cmd, but other PCs on your Tailscale network can also connect
rem (AI players via http://<this PC tailscale address>:7777/mcp). Not opened to Wi-Fi or other networks.
rem The steps are in packages\server\bin\muse-launch.mjs (Node.js 22 or later is required). Closing this window stops the server.
cd /d "%~dp0"
title MuseDungeon (share)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node "packages\server\bin\muse-launch.mjs" --share
if errorlevel 1 pause
