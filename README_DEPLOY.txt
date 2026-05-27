CoreSound Radio Server V10B

Fix:
- Removed FFmpeg options not supported by Railway/Debian ffmpeg:
  -reconnect
  -reconnect_streamed
  -reconnect_delay_max

Expected health version:
v10b-ffmpeg-no-reconnect-option-2026-05-27

Test:
GET /health
GET /debug
GET /live
