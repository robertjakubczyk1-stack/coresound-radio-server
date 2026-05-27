CoreSound Radio Server V3 — REST fetch
=====================================

Ta wersja nie używa @supabase/supabase-js. Pobiera dane przez Supabase REST API.

Podmień w repo GitHub:
- server.js
- package.json
- .env.example
- README_DEPLOY.txt

Railway ENV:
- SUPABASE_URL=https://rwnliqswwasrubqckhql.supabase.co
- SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
- PORT=3000

Testy po deployu:
/health
/debug
/now
/live

Jeśli /debug pokazuje restTest ok:true, serwer widzi Supabase.
