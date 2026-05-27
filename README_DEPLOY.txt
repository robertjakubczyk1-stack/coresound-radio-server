CoreSound Radio Server V9 — FFmpeg Continuous Stream

Purpose:
- /live no longer proxies one MP3 at a time.
- /live builds a long shuffled playlist and pipes it through FFmpeg as one continuous audio/mpeg stream.
- This is designed to be more stable on Android when screen is locked.

Required Railway variables:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
PORT=3000

Important:
- This package includes nixpacks.toml so Railway installs ffmpeg.
- After deploy, test:
  /health -> version v9-ffmpeg-continuous-stream-2026-05-27
  /debug -> restTest.ok true
  /now
  /live

If /live fails with "ffmpeg not found", Railway did not apply nixpacks.toml or did not rebuild the image.
Redeploy from latest commit or create a fresh service.
