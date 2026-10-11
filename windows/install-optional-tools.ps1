# Optional tools for video download / format conversion. Run manually as the current user.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Please install Microsoft App Installer (winget) first.' }
winget install --id yt-dlp.yt-dlp --exact --source winget --accept-source-agreements --accept-package-agreements
winget install --id Gyan.FFmpeg --exact --source winget --accept-source-agreements --accept-package-agreements
Write-Host 'Restart StudyDesk after installing tools. Optional: set STUDYDESK_YTDLP / STUDYDESK_FFMPEG to the .exe paths.'
