@echo off
REM Launches the self-hosted SigLIP-2 embedder on the home GPU (RTX 4070).
REM Registered as a Task Scheduler "At startup" task so reboots/Windows
REM Updates self-heal. See docs/scanner-runbook.md ("Keep it alive").
cd /d "%~dp0"
set /p SIGLIP_INFERENCE_TOKEN=<"%~dp0.siglip_token.txt"
"%~dp0venv\Scripts\python.exe" "%~dp0home_server.py" >> "%~dp0.home_server.log" 2>&1
