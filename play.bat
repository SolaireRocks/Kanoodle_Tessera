@echo off
rem Starts the Tessera server, opens the game here, and prints the address to
rem use from a phone on the same Wi-Fi.
rem   play.bat          -> http://localhost:5173
rem   play.bat 8080     -> a different port

setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=5173"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on PATH. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

rem This machine's address on the local network - the one a phone must type.
rem Prefer the adapter that owns the default gateway, so VirtualBox and Hyper-V
rem adapters do not win over the real Wi-Fi card.
set "LANIP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$n=(Get-NetIPConfiguration).Where({$_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'},'First'); if($n){$n[0].IPv4Address.IPAddress}else{$f=(Get-NetIPAddress -AddressFamily IPv4).Where({$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'},'First'); if($f){$f[0].IPAddress}}"`) do set "LANIP=%%i"

rem A network Windows calls "Public" refuses incoming connections outright, so
rem the firewall rule alone would not be enough there.
set "NETPUBLIC="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$p=(Get-NetConnectionProfile).Where({$_.IPv4Connectivity -ne 'Disconnected' -and $_.NetworkCategory -eq 'Public'},'First'); if($p){'1'}"`) do set "NETPUBLIC=%%i"

call :ensureFirewall

echo Starting Tessera on http://localhost:%PORT% ...
start "Tessera server" /min cmd /c "node tools\serve.mjs %PORT%"

rem Wait for the server to accept connections before opening the browser.
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(15); while((Get-Date) -lt $deadline){ try{ $c=New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 250 } }; exit 1"

if errorlevel 1 (
  echo The server did not come up. Check the "Tessera server" window for errors.
  pause
  exit /b 1
)

start "" "http://localhost:%PORT%/"

echo.
echo   On this PC:    http://localhost:%PORT%/
if defined LANIP (
  echo   On your phone: http://%LANIP%:%PORT%/   ^(same Wi-Fi^)
  echo.
  echo   Type that second address into the phone's browser. Chrome and Safari
  echo   can then "Add to Home Screen" to keep Tessera one tap away.
) else (
  echo.
  echo   No network address found - this PC looks offline, so only this
  echo   machine can reach the game right now.
)
if defined FWMISSING (
  echo.
  echo   NOTE: Windows Firewall is not open on port %PORT%, so the phone may not
  echo   connect. Allow Node.js if Windows prompts, or run play.bat again and
  echo   accept the administrator prompt.
)
if defined NETPUBLIC (
  echo.
  echo   NOTE: this Wi-Fi is set to "Public", where Windows blocks incoming
  echo   connections whatever the rule says. Settings ^> Network ^> Wi-Fi ^>
  echo   your network ^> Private makes the phone reachable.
)
echo.
echo Tessera is running. Close the "Tessera server" window to stop it.
endlocal
exit /b 0

rem ---------------------------------------------------------------------------
rem Windows blocks incoming connections by default, which is what stops a phone
rem from loading the page. The rule is per-port and only has to be added once.
:ensureFirewall
set "FWRULE=Tessera-dev-server-port-%PORT%"
netsh advfirewall firewall show rule name=%FWRULE% >nul 2>&1
if not errorlevel 1 exit /b 0

net session >nul 2>&1
if not errorlevel 1 (
  netsh advfirewall firewall add rule name=%FWRULE% dir=in action=allow protocol=TCP localport=%PORT% profile=private >nul
  goto :fwVerify
)

echo.
echo   Windows Firewall is blocking incoming connections on port %PORT%, so a
echo   phone cannot load the game yet. Opening it needs one administrator
echo   prompt, and only has to be done once for this port.
choice /c YN /n /t 15 /d Y /m "  Open port %PORT% for phones on this network? [Y,N] "
if errorlevel 2 goto :fwSkipped

powershell -NoProfile -Command "try { Start-Process netsh -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList 'advfirewall','firewall','add','rule','name=%FWRULE%','dir=in','action=allow','protocol=TCP','localport=%PORT%','profile=private' } catch { exit 1 }"

:fwVerify
netsh advfirewall firewall show rule name=%FWRULE% >nul 2>&1
if errorlevel 1 goto :fwSkipped
echo   Firewall rule added.
exit /b 0

:fwSkipped
set "FWMISSING=1"
exit /b 0
