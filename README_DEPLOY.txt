CoreSound Radio Server V7

Fix:
- Uses Supabase REST select=* instead of selecting audio_url directly.
- This avoids schema errors like: column tracks.audio_url does not exist.
- Keeps Railway public DNS / HTTPS fallback.
- /health version: v7-select-star-schema-safe-2026-05-27

Required Railway variables:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
PORT=3000

Test:
GET /health
GET /debug
GET /now
GET /live
