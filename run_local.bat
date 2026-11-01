@echo off
REM Tulare Basin Groundwater Explorer - test the website on your own computer.
REM Double-click this file. A browser tab opens at http://localhost:8000
REM Keep this black window open while you use the site; close it to stop.
cd /d "%~dp0docs"
echo Starting a local web server in: %cd%
echo Open http://localhost:8000 if the browser does not open by itself.
start "" http://localhost:8000
python -m http.server 8000
if errorlevel 1 (
  echo.
  echo Python was not found. Open the Anaconda Prompt, then run:
  echo     cd /d "%~dp0docs"
  echo     python -m http.server 8000
  pause
)
