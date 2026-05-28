CoreSound Radio Server V15 — HLS Broadcast Engine

Professional direction:
- FFmpeg generates /hls/index.m3u8 and .ts segments.
- /player is a phone test page using hls.js.
- /live redirects to /hls/index.m3u8.
- Engine auto-starts after deploy.

Expected /health version:
v15-hls-broadcast-engine-2026-05-28

Test:
1. /health
2. /debug
3. /player on phone
4. later integrate RadioPanel with hls.js
