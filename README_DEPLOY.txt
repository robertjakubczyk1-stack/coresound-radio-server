CoreSound Radio Server — Railway-ready
======================================

CEL
---
To jest osobny serwer radiowy dla CoreSound.
Telefon odtwarza jeden ciągły endpoint:

  /live

Dzięki temu telefon nie musi wykonywać JavaScriptowego onEnded między utworami.
To ma ominąć problem Androida: ekran wygaszony -> JS śpi -> radio nie przeskakuje.

PLIKI
-----
server.js
package.json
.env.example
README_DEPLOY.txt

WDROŻENIE NA RAILWAY
-------------------
1. Wejdź na Railway.
2. New Project.
3. Deploy from GitHub albo wrzuć ten folder jako nowy projekt.
4. Ustaw zmienne ENV:

   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   CORESOUND_RADIO_SLOT_SECONDS=210
   ALLOWED_ORIGIN=*

5. Railway sam ustawi PORT.
6. Deploy.
7. Po deployu sprawdź:

   https://TWOJ-PROJEKT.up.railway.app/health
   https://TWOJ-PROJEKT.up.railway.app/now
   https://TWOJ-PROJEKT.up.railway.app/live

UWAGA O SERVICE ROLE KEY
------------------------
SUPABASE_SERVICE_ROLE_KEY jest tajny.
Nie wklejaj go publicznie i nie dawaj do frontendu.
Może być tylko w ENV Railway.

CO DALEJ
--------
Po działającym /live trzeba zmienić CoreSound frontend:
RadioPanel.tsx powinien dla CoreSound Radio używać:

  https://TWOJ-PROJEKT.up.railway.app/live

Zamiast lokalnych endpointów Vercel.

OGRANICZENIA MVP
----------------
To jest MVP bez transkodowania.
Serwer skleja kolejne pliki audio jako strumień audio/mpeg.
Najlepiej działa, jeśli utwory są MP3.
Jeżeli w bazie są różne formaty albo uszkodzone pliki, serwer je pominie i pójdzie dalej.

ENDPOINTY
---------
GET /health  - status serwera
GET /now     - aktualny/ następny utwór według programu
GET /refresh - wymusza odświeżenie puli z Supabase
GET /live    - ciągły stream radia
