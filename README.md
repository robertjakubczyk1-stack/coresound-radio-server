# CoreSound Radio Stream Engine V2 — Stage 1

Ten katalog jest osobnym workerem streamingu. Nie zastępuje CoreSound i nie zmienia admina, Androida ani zwykłego playera.

## Architektura

```text
CoreSound / Vercel
/api/radio/now-playing
        ↓
Radio Stream Engine V2
FFmpeg + HLS
        ↓
/playlist.m3u8 + segmenty .ts
        ↓
Android / Web radio
```

Źródłem prawdy zostaje obecny CoreSound:

- `tracks`
- `artists`
- `radio_configs`
- `radio_inserts` w dalszym etapie
- `/api/radio/now-playing`

Ten worker tylko zamienia aktualną kolejkę CoreSound w prawdziwszy HLS przez FFmpeg.

## Co jest w Stage 1

- Express server.
- Pobieranie `/api/radio/now-playing` z CoreSound.
- Pobieranie aktualnego utworu i kolejnych pozycji z kolejki.
- Uruchomienie FFmpeg.
- Generowanie:
  - `/playlist.m3u8`
  - `/hls/segment_*.ts`
- Endpoint diagnostyczny `/status`.

## Czego Stage 1 jeszcze nie robi

- Nie podpina jeszcze Androida.
- Nie zmienia `RadioPanel.tsx`.
- Nie obsługuje jeszcze pełnego harmonogramu sampli/jingli.
- Nie jest jeszcze produkcyjnym radiem 24/7.
- Nie rozwiązuje darmowego hostingu 24/7 — Render free może usypiać usługę.

## Uruchomienie lokalne

Wymagane:

- Node.js 20+
- FFmpeg

```bash
cd radio-stream-engine
cp .env.example .env
npm install
npm run check
npm start
```

Test:

```text
http://localhost:8787/health
http://localhost:8787/status
http://localhost:8787/playlist.m3u8
```

Playlistę najlepiej testować w VLC:

```text
http://localhost:8787/playlist.m3u8
```

## Konfiguracja

Najważniejsze zmienne `.env`:

```env
CORESOUND_BASE_URL=https://v0-tiktok-website-design-roan.vercel.app
PORT=8787
FFMPEG_BIN=ffmpeg
HLS_TIME_SECONDS=6
HLS_LIST_SIZE=12
AUDIO_BITRATE=128k
USE_ORIGINAL_STREAM_URL=1
```

`USE_ORIGINAL_STREAM_URL=1` oznacza, że worker bierze bezpośredni link Dropbox/Supabase z `original_stream_url`, jeśli `/api/radio/now-playing` go zwraca.

`USE_ORIGINAL_STREAM_URL=0` oznacza, że worker bierze proxy CoreSound `/api/radio/stream?trackId=...`.

## Deploy na Render

1. Wrzuć folder `radio-stream-engine` do osobnego repozytorium GitHub albo jako osobny katalog w repo.
2. W Render utwórz `New Web Service`.
3. Wybierz Docker.
4. Ustaw zmienne środowiskowe z `.env.example`.
5. Po deployu sprawdź:

```text
https://twoj-render-url.onrender.com/health
https://twoj-render-url.onrender.com/status
https://twoj-render-url.onrender.com/playlist.m3u8
```

## Ważne

Darmowy Render może usypiać usługę. Do prawdziwego radia 24/7 docelowo lepszy będzie tani VPS. Ten Stage 1 służy do potwierdzenia architektury bez ruszania stabilnego CoreSound.


## Poprawka w tej paczce

Ta paczka naprawia układ plików i usuwa najważniejszą przyczynę `live:false` w HLS:

- `src/ffmpeg-runner.js` używa `omit_endlist+temp_file`, żeby FFmpeg nie kończył playlisty i zapisywał pliki bez półgotowych odczytów.
- `src/server.js` dodatkowo usuwa `#EXT-X-ENDLIST` z playlisty jako bezpiecznik.
- Testowy `/player` ma zabezpieczenie przed wielokrotnym twardym reloadem HLS naraz.
- `.env.example` ma wartości zgodne z testami: `HLS_LIST_SIZE=36`, `HLS_DELETE_THRESHOLD=24`.

Jeżeli po tej poprawce nadal pojawia się `audio ended - reloading live`, trzeba przejść do etapu V3: długowieczny FFmpeg/concat demuxer albo worker stale karmiony kolejką, bo obecny Stage 1 nadal generuje skończone paczki utworów.
