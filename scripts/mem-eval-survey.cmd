@echo off
chcp 65001 >nul
setlocal
title mem-eval survey

set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

if exist "%PY%" goto havepython
where py >nul 2>nul
if %errorlevel%==0 (set "PY=py") else (set "PY=python")

:havepython
echo.
echo Collecting store statistics (read-only, no conversation text is exported)...
echo.
"%PY%" "%~dp0mem-eval-survey.py" %*
echo.
echo Copy the JSON above back to the instructor. Nothing else is needed.
pause
