CoreSound Radio Server V14B — Always-On Broadcast Engine with Buffer Guard

This is the safer version of V14.

Fix over V14:
- Adds BUFFER_FILL_MAX_ATTEMPTS so bad Dropbox links cannot trap the radio in an endless buffer-fill loop.
- Adds BROADCAST_RESTART_DELAY_MS so crash/restart loops are slower and safer.
- Keeps always-on shared broadcast, local /tmp cache, FFmpeg, Dockerfile.

Expected /health version:
v14b-always-on-buffer-guard-2026-05-27

Required Railway variables:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
PORT=8080 or Railway-provided PORT

Optional:
ALWAYS_ON_RADIO=true
RADIO_START_DELAY_MS=3000
BROADCAST_RESTART_DELAY_MS=5000
LOCAL_BUFFER_SIZE=4
BUFFER_FILL_MAX_ATTEMPTS=40
DOWNLOAD_TIMEOUT_MS=45000
MAX_DOWNLOAD_BYTES=83886080
STREAM_BITRATE=128k
MAX_FFMPEG_PLAYLIST_TRACKS=100
LINK_CHECK_TIMEOUT_MS=6500

Test:
GET /health
GET /debug
GET /now
GET /live
