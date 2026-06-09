import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { config, validateConfig } from './config.js'
import { RadioStreamEngine } from './engine.js'
import { log } from './logger.js'

const errors = validateConfig()
if (errors.length > 0) {
  console.error('Configuration errors:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

const app = express()
const engine = new RadioStreamEngine()

app.disable('x-powered-by')

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

function hlsFilePath(fileName) {
  return path.join(config.hlsDir, fileName)
}

function isSafeSegmentName(fileName) {
  return /^segment_\d+\.ts$/.test(String(fileName || ''))
}

function sendPlaylist(_req, res) {
  const file = hlsFilePath('playlist.m3u8')

  if (!fs.existsSync(file)) {
    return res
      .status(503)
      .type('text/plain')
      .send('HLS playlist is not ready yet. Wait a few seconds and refresh.')
  }

  let body = fs.readFileSync(file, 'utf8')
  // Radio ma być prawdziwym live HLS. FFmpeg po zakończeniu skończonej paczki
  // potrafi dopisać #EXT-X-ENDLIST, przez co HLS.js widzi live:false i wywołuje ended.
  // Endpoint usuwa ENDLIST awaryjnie, a ffmpeg-runner używa też flagi omit_endlist.
  body = body.replace(/^#EXT-X-ENDLIST\s*$/gm, '')
  body = body.replace(/^(segment_\d+\.ts)$/gm, '/hls/$1')
  if (!body.endsWith('\n')) body += '\n'

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.send(body)
}

function sendSegment(req, res) {
  const segmentName = req.params.segment

  if (!isSafeSegmentName(segmentName)) {
    return res.status(400).type('text/plain').send('Invalid segment name')
  }

  const file = hlsFilePath(segmentName)

  if (!fs.existsSync(file)) {
    return res.status(404).type('text/plain').send('Segment not found')
  }

  res.setHeader('Content-Type', 'video/mp2t')
  res.setHeader('Cache-Control', 'public, max-age=60, immutable')
  res.sendFile(file)
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'coresound-radio-stream-engine-v2',
    time: new Date().toISOString(),
  })
})

app.get('/status', (_req, res) => {
  res.json(engine.status())
})

app.get('/debug/hls', (_req, res) => {
  let files = []
  let exists = false

  try {
    exists = fs.existsSync(config.hlsDir)
    files = exists ? fs.readdirSync(config.hlsDir).sort().slice(-80) : []
  } catch (err) {
    return res.status(500).json({
      ok: false,
      hlsDir: config.hlsDir,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  res.json({
    ok: true,
    hlsDir: config.hlsDir,
    exists,
    fileCount: files.length,
    files,
  })
})

app.get(
  ['/playlist.m3u8', '/radio/playlist.m3u8', '/live/playlist.m3u8', '/hls/playlist.m3u8'],
  sendPlaylist,
)

app.get('/hls/:segment', sendSegment)

app.get('/player', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  res.send(`<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CoreSound Live HLS Test Player</title>
  <style>
    body {
      margin: 0;
      background: #050505;
      color: #f5f5f5;
      font-family: Arial, sans-serif;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    .box {
      width: min(820px, calc(100vw - 32px));
      border: 1px solid #333;
      border-radius: 18px;
      padding: 24px;
      background: #111;
    }
    h1 { margin: 0 0 16px; font-size: 24px; }
    audio { width: 100%; margin: 16px 0; }
    button {
      border: 0;
      border-radius: 10px;
      padding: 12px 16px;
      cursor: pointer;
      font-weight: bold;
      margin-right: 8px;
    }
    .status {
      font-size: 13px;
      color: #ccc;
      margin-top: 10px;
      line-height: 1.5;
    }
    pre {
      background: #000;
      padding: 12px;
      border-radius: 10px;
      overflow: auto;
      max-height: 320px;
      font-size: 12px;
      color: #9cff9c;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>CoreSound Live HLS Test Player</h1>
    <audio id="audio" controls autoplay></audio>
    <div>
      <button id="playBtn">PLAY</button>
      <button id="reloadBtn">RELOAD LIVE</button>
    </div>
    <div class="status" id="status">Status: start...</div>
    <pre id="log"></pre>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script>
    const audio = document.getElementById('audio')
    const logBox = document.getElementById('log')
    const statusBox = document.getElementById('status')
    const src = '/playlist.m3u8'

    let hls = null
    let waitingSince = 0
    let lastRecoverAt = 0
    let recoverCount = 0
    let healthTimer = null
    let isStarting = false
    let lastHardReloadAt = 0

    function log(message, data) {
      const line =
        '[' +
        new Date().toLocaleTimeString() +
        '] ' +
        message +
        (data ? ' ' + JSON.stringify(data) : '')

      logBox.textContent = line + '\\n' + logBox.textContent
    }

    function updateStatus(extra) {
      const buffered =
        audio.buffered && audio.buffered.length
          ? {
              start: Number(audio.buffered.start(0).toFixed(2)),
              end: Number(audio.buffered.end(audio.buffered.length - 1).toFixed(2)),
            }
          : null

      statusBox.textContent =
        'Status: ' +
        [
          audio.paused ? 'paused' : 'playing',
          'current=' + Number(audio.currentTime || 0).toFixed(2),
          buffered ? 'buffer=' + buffered.start + '-' + buffered.end : 'buffer=empty',
          'recoveries=' + recoverCount,
          extra || '',
        ]
          .filter(Boolean)
          .join(' | ')
    }

    function softRecover(reason) {
      const now = Date.now()

      if (now - lastRecoverAt < 8000) {
        log('Recover skipped - too soon', { reason })
        return
      }

      lastRecoverAt = now
      recoverCount += 1

      log('Soft recover without seeking', { reason, recoverCount })

      if (hls) {
        try {
          hls.startLoad()
        } catch (err) {
          log('hls.startLoad failed', { message: err.message })
        }

        if (reason === 'media-error') {
          try {
            hls.recoverMediaError()
          } catch (err) {
            log('hls.recoverMediaError failed', { message: err.message })
          }
        }
      }

      audio.play().catch((err) => {
        log('play after recover failed', { message: err.message })
      })

      updateStatus('soft-recover')
    }

    function hardReload(reason) {
      const now = Date.now()
      if (isStarting || now - lastHardReloadAt < 15000) {
        log('Hard reload skipped - already starting or too soon', { reason })
        return
      }
      lastHardReloadAt = now
      log('Hard reload HLS', { reason })
      start()
    }

    function startHealthLoop() {
      if (healthTimer) clearInterval(healthTimer)

      healthTimer = setInterval(() => {
        updateStatus()

        if (!waitingSince) return

        const waitingForMs = Date.now() - waitingSince

        if (waitingForMs > 20000 && waitingForMs <= 90000) {
          softRecover('waiting-too-long')
        }

        if (waitingForMs > 90000) {
          hardReload('waiting-over-90s')
        }
      }, 2000)
    }

    function start() {
      if (isStarting) return
      isStarting = true
      waitingSince = 0

      if (hls) {
        hls.destroy()
        hls = null
      }

      if (Hls.isSupported()) {
        hls = new Hls({
          // Stabilny tryb radia: nie gonimy agresywnie live edge.
          // Player ma grać z bezpiecznym opóźnieniem, żeby nie przeskakiwał.
          lowLatencyMode: false,
          liveSyncDuration: 90,
          liveMaxLatencyDuration: 240,
          maxLiveSyncPlaybackRate: 1,
          maxBufferLength: 180,
          maxMaxBufferLength: 360,
          backBufferLength: 120,
          enableWorker: true,
          nudgeOffset: 0.05,
          nudgeMaxRetry: 2,
          maxFragLookUpTolerance: 0.25,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 12,
          manifestLoadingRetryDelay: 1000,
          levelLoadingTimeOut: 20000,
          levelLoadingMaxRetry: 12,
          fragLoadingTimeOut: 30000,
          fragLoadingMaxRetry: 12,
          fragLoadingRetryDelay: 1000,
        })

        hls.on(Hls.Events.ERROR, function (_event, data) {
          log('HLS ERROR', {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
          })

          if (data.details === 'bufferStalledError') {
            log('bufferStalledError observed - waiting before recovery')
            return
          }

          if (data.details === 'bufferNudgeOnStall') {
            log('bufferNudgeOnStall observed - waiting before recovery')
            return
          }

          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              softRecover('network-error')
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              softRecover('media-error')
            } else {
              hardReload('fatal-other')
            }
          }
        })

        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          log('Manifest parsed')
          audio.play().catch((err) => log('Autoplay blocked', { message: err.message }))
        })

        hls.on(Hls.Events.LEVEL_LOADED, function (_event, data) {
          log('Live playlist loaded', {
            live: data.details.live,
            fragments: data.details.fragments.length,
            mediaSequence: data.details.startSN,
            endSequence: data.details.endSN,
          })

          if (!data.details.live) {
            log('WARNING: playlist parsed as VOD/live=false - check #EXT-X-ENDLIST')
          }
        })

        hls.on(Hls.Events.FRAG_BUFFERED, function () {
          if (waitingSince && audio.readyState >= 3) {
            waitingSince = 0
            audio.play().catch((err) => log('play after fragment buffered failed', { message: err.message }))
          }
        })

        hls.loadSource(src)
        hls.attachMedia(audio)

        log('HLS.js started - stable live sync 90s')
        setTimeout(() => { isStarting = false }, 1000)
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = src
        audio.play().catch((err) => log('Autoplay blocked', { message: err.message }))
        log('Native HLS started')
        setTimeout(() => { isStarting = false }, 1000)
      } else {
        log('HLS not supported in this browser')
        isStarting = false
      }

      startHealthLoop()
    }

    document.getElementById('playBtn').onclick = () => {
      audio.play().catch((err) => log('manual play failed', { message: err.message }))
    }

    document.getElementById('reloadBtn').onclick = () => start()

    audio.addEventListener('waiting', () => {
      if (!waitingSince) waitingSince = Date.now()
      log('audio waiting')
      updateStatus('waiting')
    })

    audio.addEventListener('playing', () => {
      waitingSince = 0
      log('audio playing')
      updateStatus('playing')
    })

    audio.addEventListener('stalled', () => {
      if (!waitingSince) waitingSince = Date.now()
      log('audio stalled')
      softRecover('audio-stalled')
    })

    audio.addEventListener('pause', () => updateStatus('pause'))

    audio.addEventListener('ended', () => {
      log('audio ended - reloading live')
      setTimeout(() => start(), 1000)
    })

    start()
  </script>
</body>
</html>`)
})

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    [
      'CoreSound Radio Stream Engine V2',
      '',
      'Endpoints:',
      '- /health',
      '- /status',
      '- /debug/hls',
      '- /playlist.m3u8',
      '- /hls/playlist.m3u8',
      '- /hls/<segment>.ts',
      '- /player',
      '',
    ].join('\\n'),
  )
})

const server = app.listen(config.port, async () => {
  log.info(`CoreSound Radio Stream Engine listening on port ${config.port}`)
  log.info(`CoreSound source: ${config.coreSoundBaseUrl}/api/radio/now-playing`)
  log.info(`HLS directory: ${config.hlsDir}`)

  try {
    await engine.start()
  } catch (err) {
    log.error('Engine startup failed', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down`)
  await engine.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
