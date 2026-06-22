@echo off
setlocal EnableExtensions

rem Link this package into a Node-RED userDir for local development.
rem Override userDir: set NODE_RED_USER_DIR=D:\path\to\.node-red

set "PROJECT_DIR=%~dp0"
set "PACKAGE_NAME=node-red-contrib-s7-plus"

if not defined NODE_RED_USER_DIR set "NODE_RED_USER_DIR=%USERPROFILE%\.node-red"

echo.
echo Linking %PACKAGE_NAME% for Node-RED development
echo   Project:  %PROJECT_DIR%
echo   userDir:  %NODE_RED_USER_DIR%
echo.

if not exist "%NODE_RED_USER_DIR%" (
    echo ERROR: Node-RED userDir not found: %NODE_RED_USER_DIR%
    echo Create it first ^(run node-red once^) or set NODE_RED_USER_DIR.
    exit /b 1
)

cd /d "%PROJECT_DIR%"
call npm link
if errorlevel 1 (
    echo ERROR: npm link failed in project directory.
    exit /b 1
)

cd /d "%NODE_RED_USER_DIR%"
call npm link %PACKAGE_NAME%
if errorlevel 1 (
    echo ERROR: npm link failed in Node-RED userDir.
    echo Tip: try "npm install %PROJECT_DIR%" instead if symlinks are blocked.
    exit /b 1
)

echo.
echo Done. Restart Node-RED to load the linked nodes.
echo Debug: set S7P_DEBUG=client,endpoint,transport before starting Node-RED.
echo.

endlocal
