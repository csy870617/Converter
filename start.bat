@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 간단 파일 변환기

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Python이 설치되어 있지 않습니다.
  echo  열리는 페이지에서 Python을 설치해 주세요.
  echo  설치 화면 첫 페이지에서 "Add python.exe to PATH" 를 꼭 체크하세요.
  echo.
  start https://www.python.org/downloads/
  pause
  exit /b 1
)

if not exist ".venv\installed.txt" (
  echo  처음 실행 준비 중입니다. 몇 분 정도 걸릴 수 있습니다...
  python -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :fail
  echo ok> ".venv\installed.txt"
)

".venv\Scripts\python.exe" app.py
exit /b 0

:fail
echo.
echo  설치 중 문제가 발생했습니다. 인터넷 연결을 확인한 뒤 .venv 폴더를 지우고 다시 실행해 주세요.
pause
exit /b 1
