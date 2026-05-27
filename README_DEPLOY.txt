CoreSound Radio Server V5 — Network fallback

Wersja: v5-network-fallback-2026-05-27

Zmiany:
- REST API Supabase bez SDK.
- Fallback: jeśli global fetch pada na Railway, serwer próbuje node:https z IPv4.
- /debug pokazuje DNS i dokładną przyczynę błędu.

ENV:
SUPABASE_URL=https://rwnliqswwasrubqckhql.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
PORT=3000
