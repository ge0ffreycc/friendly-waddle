@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 检查 electron 是否安装
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
    echo [错误] 未检测到 Electron 运行时。
    echo 请先在项目目录下运行：  npm install
    echo.
    pause
    exit /b 1
)

rem 启动应用
start "" "%~dp0node_modules\electron\dist\electron.exe" .
