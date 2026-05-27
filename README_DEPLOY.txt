CoreSound Radio Server V6 — forced public DNS

Cel poprawki:
- Railway zwracał ENOTFOUND dla rwnliqswwasrubqckhql.supabase.co.
- V6 wymusza publiczne DNS resolvery: 1.1.1.1 oraz 8.8.8.8.
- Wersja widoczna w /health i /debug: v6-forced-public-dns-2026-05-27.

Wgraj do repo coresound-radio-server:
- server.js
- package.json
- .env.example
- README_DEPLOY.txt

Commit bezpośrednio do main.
Po deployu sprawdź:
/health
/debug
/now
/live
