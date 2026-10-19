@echo off
REM ============================================================================
REM rt-harness - one-shot setup script (Windows 10/11)
REM
REM   setup.bat            install everything, then start the app
REM   setup.bat --no-run   install everything, don't start
REM
REM Checks/installs: Node.js (>=20) + npm (via winget, or download fallback),
REM all npm dependencies (root, server, client), native module verification
REM (better-sqlite3, node-pty), and a verification build of both packages.
REM It does NOT install any model server (Ollama/FreeToken/MLX/...) - you choose
REM which provider and model to use; the script only checks whether an
REM OpenAI-compatible server is already reachable.
REM ============================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NORUN="
if /i "%~1"=="--no-run" set "NORUN=1"

set REQUIRED_NODE_MAJOR=20

echo [setup] rt-harness setup starting...
echo.

REM ----------------------------------------------------------------------------
REM 1. Node.js >= 20 + npm
REM ----------------------------------------------------------------------------
set NODE_OK=0
where node >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=* usebackq" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set NODE_MAJOR=%%v
    if !NODE_MAJOR! GEQ %REQUIRED_NODE_MAJOR% set NODE_OK=1
)

if %NODE_OK%==1 (
    for /f "tokens=* usebackq" %%v in (`node -v`) do set NODEV=%%v
    for /f "tokens=* usebackq" %%v in (`npm -v`) do set NPMV=%%v
    echo [ ok ] Node.js !NODEV! + npm !NPMV!
    goto :deps
)

where node >nul 2>&1
if %errorlevel%==0 (
    echo [warn] Node.js is too old - need ^>= %REQUIRED_NODE_MAJOR%. Installing upgrade...
) else (
    echo [setup] Node.js not found. Installing...
)

REM Try winget first (built into Windows 10 1709+ / 11)
where winget >nul 2>&1
if %errorlevel%==0 (
    echo [setup] Installing Node.js LTS via winget...
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    goto :node_check
)

REM Fallback: chocolatey
where choco >nul 2>&1
if %errorlevel%==0 (
    echo [setup] Installing Node.js LTS via chocolatey...
    choco install nodejs-lts -y
    goto :node_check
)

REM Last resort: direct MSI download
echo [setup] No winget/choco found. Downloading Node.js LTS installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v20.x/' -UseBasicParsing -OutFile "$env:TEMP\nodedir.html" } catch { exit 1 }"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$links = Select-String -Path \"$env:TEMP\nodedir.html\" -Pattern 'node-v[0-9.]+-x64\.msi' -AllMatches; $m = $links.Matches[0].Value; Invoke-WebRequest -Uri \"https://nodejs.org/dist/latest-v20.x/$m\" -OutFile \"$env:TEMP\node-setup.msi\""
if not exist "%TEMP%\node-setup.msi" (
    echo [fail] Could not download Node.js. Install Node %REQUIRED_NODE_MAJOR%+ from https://nodejs.org and re-run.
    pause & exit /b 1
)
echo [setup] Running Node.js installer (may ask for admin approval)...
msiexec /i "%TEMP%\node-setup.msi" /passive
del "%TEMP%\node-setup.msi" 2>nul

REM Refresh PATH for the current session (default Node install location)
set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm"

:node_check
set NODE_OK=0
where node >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=* usebackq" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set NODE_MAJOR=%%v
    if !NODE_MAJOR! GEQ %REQUIRED_NODE_MAJOR% set NODE_OK=1
)
if %NODE_OK%==0 (
    echo [fail] Node.js %REQUIRED_NODE_MAJOR%+ is still not available.
    echo        If it was just installed, close this window, open a NEW terminal, and re-run setup.bat
    pause & exit /b 1
)
for /f "tokens=* usebackq" %%v in (`node -v`) do set NODEV=%%v
echo [ ok ] Node.js !NODEV! ready

REM ----------------------------------------------------------------------------
REM 2. Model server check (NOT installed here - just detected)
REM    rt-harness works with ANY OpenAI-compatible provider. We never assume
REM    which one you'll run; if none is reachable we just tell you.
REM ----------------------------------------------------------------------------
echo.
set MODEL_FOUND=
for %%P in (11434 1919 8080 1234 8000 1337 11435) do (
    if not defined MODEL_FOUND (
        powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri ('http://127.0.0.1:%%P/v1/models') -UseBasicParsing -TimeoutSec 2; exit 0 } catch { try { $r = Invoke-WebRequest -Uri ('http://127.0.0.1:%%P/models') -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 } }" >nul 2>&1
        if not errorlevel 1 set MODEL_FOUND=%%P
    )
)
if defined MODEL_FOUND (
    echo [ ok ] Model server detected on http://127.0.0.1:!MODEL_FOUND! - you're all set
) else (
    echo [warn] No model server detected on common ports ^(11434/1919/8080/1234...^).
    echo        rt-harness works with ANY OpenAI-compatible server. Start whichever
    echo        you prefer, e.g.:
    echo          - Ollama:            ollama serve
    echo          - FreeToken:         start your freetoken server
    echo          - MLX-LM ^(Apple^):    mlx_lm.server --model ^<model^> --port 8080
    echo          - LM Studio / vLLM:  start with its OpenAI-compatible port
    echo        Then add it in the app: model switcher -^> + Add custom endpoint
    echo        ^(built-ins Ollama/FreeToken/MLX are already prefilled^).
)

REM ----------------------------------------------------------------------------
REM 3. npm dependencies
REM ----------------------------------------------------------------------------
:deps
echo.
echo [setup] Installing dependencies (this can take a few minutes)...

echo [setup] .\ (project root)
call npm install --no-audit --no-fund
if errorlevel 1 ( echo [fail] npm install failed in project root & pause & exit /b 1 )

echo [setup] .\server
pushd server
call npm install --no-audit --no-fund
if errorlevel 1 ( popd & echo [fail] npm install failed in server\ & pause & exit /b 1 )
popd

echo [setup] .\client
pushd client
call npm install --no-audit --no-fund
if errorlevel 1 ( popd & echo [fail] npm install failed in client\ & pause & exit /b 1 )
popd

echo [ ok ] All npm dependencies installed

REM ----------------------------------------------------------------------------
REM 4. Native modules sanity check (better-sqlite3, node-pty)
REM    These need prebuilt binaries matching your Node version; rebuild if broken.
REM    (Full rebuild needs VS Build Tools — script tells you if that's required.)
REM ----------------------------------------------------------------------------
echo.
echo [setup] Verifying native modules (better-sqlite3, node-pty)...
pushd server
node -e "require('better-sqlite3'); require('node-pty')" >nul 2>&1
if errorlevel 1 (
    echo [warn] Native modules broken - attempting rebuild from source...
    echo [warn] If this fails, install Visual Studio Build Tools: npm install -g windows-build-tools
    call npm rebuild better-sqlite3 node-pty --build-from-source
    if errorlevel 1 ( popd & echo [fail] Native module rebuild failed & pause & exit /b 1 )
)
popd
echo [ ok ] Native modules load correctly

REM ----------------------------------------------------------------------------
REM 5. Verification build
REM ----------------------------------------------------------------------------
echo.
echo [setup] Building server + client (verification)...
pushd server
call npm run build
if errorlevel 1 ( popd & echo [fail] Server build failed & pause & exit /b 1 )
popd
pushd client
call npm run build
if errorlevel 1 ( popd & echo [fail] Client build failed & pause & exit /b 1 )
popd

echo.
echo ============================================================
echo   rt-harness is ready!
echo ============================================================
echo.
echo   Start everything (server :8787 + client :5173):
echo       npm run dev
echo.
echo   Then open http://localhost:5173
echo.
echo   Model server: start YOUR provider before chatting ^(Ollama, FreeToken,
echo   MLX-LM, LM Studio, vLLM - anything OpenAI-compatible^).
echo.

if defined NORUN (
    echo [setup] Skipping startup (--no-run given).
    exit /b 0
)

choice /C YN /N /M "Start rt-harness now? [Y/n] "
if errorlevel 2 exit /b 0

echo [setup] Starting server + client (close this window to stop both)...
call npm run dev
