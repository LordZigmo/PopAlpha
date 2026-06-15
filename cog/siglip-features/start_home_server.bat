@echo off
REM Launches the self-hosted SigLIP-2 embedder on the home GPU (RTX 4070).
REM Registered as a Task Scheduler "At startup" task (runs as SYSTEM, before
REM login) so a power-cut reboot self-heals with no one logged in.
REM See docs/scanner-runbook.md ("Keep it alive" / "Storm resilience").
cd /d "%~dp0"

REM Load model weights from the local cache and do NOT depend on the
REM internet being up after a storm. Weights are pre-downloaded (~1.4GB).
set "HF_HOME=C:\Users\ZachD\.cache\huggingface"
set "HF_HUB_OFFLINE=1"

REM Idempotency guard: if the server is already serving on 8788, exit.
REM Lets a SYSTEM boot-task and a logon launch coexist without a port clash.
curl -sf http://127.0.0.1:8788/health >nul 2>&1 && (
  echo [%date% %time%] already serving on 8788, exiting >> "%~dp0.home_server.log"
  exit /b 0
)

REM Inference token (gitignored). Read from file so this works as SYSTEM
REM without relying on a per-user environment variable.
set /p SIGLIP_INFERENCE_TOKEN=<"%~dp0.siglip_token.txt"

REM Self-restart loop: if the server ever exits (crash, GPU hiccup), wait
REM 5s and relaunch. The startup task handles reboots; this handles crashes.
:loop
"%~dp0venv\Scripts\python.exe" "%~dp0home_server.py" >> "%~dp0.home_server.log" 2>&1
echo [%date% %time%] server exited (code %errorlevel%), restarting in 5s >> "%~dp0.home_server.log"
timeout /t 5 /nobreak > nul
goto loop
