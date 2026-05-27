CoreSound Radio Server V8

Fix:
- /live now advances the queue after successful stream completion even when browser uses Range requests.
- This prevents repeating the same track forever in direct browser playback / RadioPanel restart flow.
- Keeps V7 schema-safe select=* and public DNS workaround.

Required Railway variables:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
PORT=3000

Test:
GET /health -> version v8-live-advance-after-stream-2026-05-27
GET /debug
GET /now
GET /live
