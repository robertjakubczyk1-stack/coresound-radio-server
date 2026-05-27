CoreSound Radio Server V10 — FFmpeg skip bad links

Fix:
- Before building the FFmpeg playlist, the server checks audio URLs.
- Broken Dropbox/Supabase links are skipped instead of killing the whole stream.
- /debug shows lastSkippedBadLinks and cachedFfmpegValidTracks.
- Keeps Dockerfile with ffmpeg installed.

Required Railway variables:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
PORT=8080 or Railway-provided PORT

Optional:
STREAM_BITRATE=128k
MAX_FFMPEG_PLAYLIST_TRACKS=80
LINK_CHECK_TIMEOUT_MS=6500

Test:
GET /health -> v10-ffmpeg-skip-bad-links-2026-05-27
GET /debug
GET /live
