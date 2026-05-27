import dns from "node:dns"
import https from "node:https"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import express from "express"
import cors from "cors"

// Railway DNS workaround.
dns.setServers(["1.1.1.1", "8.8.8.8"])
dns.setDefaultResultOrder("ipv4first")

const VERSION = "v10b-ffmpeg-no-reconnect-option-2026-05-27"
const PORT = Number.parseInt(process.env.PORT || "8080", 10)
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "")
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"
const MAX_TRACKS = 500
const PLAYLIST_REPEAT_COUNT = 25
const STREAM_BITRATE = process.env.STREAM_BITRATE || "128k"
const LINK_CHECK_TIMEOUT_MS = Number.parseInt(process.env.LINK_CHECK_TIMEOUT_MS || "6500", 10)
const MAX_FFMPEG_PLAYLIST_TRACKS = Number.parseInt(process.env.MAX_FFMPEG_PLAYLIST_TRACKS || "80", 10)
const VALID_TRACKS_CACHE_MS = Number.parseInt(process.env.VALID_TRACKS_CACHE_MS || "300000", 10)

const app = express()
app.use(cors({ origin: ALLOWED_ORIGIN }))
app.use(express.json({ limit: "1mb" }))

let cachedTracks = []
let lastTracksFetchAt = 0
let lastTracksError = null
let currentTrackIndex = 0
let cachedFfmpegValidTracks = []
let lastFfmpegValidTracksAt = 0
let lastSkippedBadLinks = []

function normalizeAudioUrl(input) {
  const raw = String(input || "").trim()
  if (!raw) return ""

  try {
    const url = new URL(raw)
    const isDropbox =
      url.hostname === "dropbox.com" ||
      url.hostname === "www.dropbox.com" ||
      url.hostname === "dl.dropboxusercontent.com"

    if (!isDropbox) return raw

    if (url.hostname === "dropbox.com" || url.hostname === "www.dropbox.com") {
      url.hostname = "dl.dropboxusercontent.com"
    }

    url.searchParams.delete("dl")
    url.searchParams.delete("raw")
    url.searchParams.delete("st")

    return url.toString()
  } catch {
    return raw
      .replace("https://www.dropbox.com", "https://dl.dropboxusercontent.com")
      .replace("https://dropbox.com", "https://dl.dropboxusercontent.com")
      .replace("?dl=0", "")
      .replace("&dl=0", "")
      .replace("?raw=1", "")
      .replace("&raw=1", "")
      .replace(/([?&])st=[^&]+&?/g, "$1")
      .replace(/[?&]$/, "")
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const clean = String(value || "").trim()
    if (clean) return clean
  }
  return ""
}

function pickAudioUrl(row) {
  return normalizeAudioUrl(
    firstNonEmpty(
      row?.stream_url,
      row?.audio_url,
      row?.file_url,
      row?.url,
      row?.audioUrl,
      row?.streamUrl,
      row?.audio,
      row?.src
    )
  )
}

function pickCoverUrl(row) {
  return firstNonEmpty(
    row?.cover_url,
    row?.avatar_url,
    row?.artist_avatar_url,
    row?.image_url,
    row?.thumbnail_url,
    row?.logo_url
  ) || null
}

function pickArtistName(row) {
  return firstNonEmpty(
    row?.artist_name,
    row?.artistName,
    row?.artist,
    row?.creator_name,
    row?.author,
    "CoreSound"
  )
}

function mapTrack(row) {
  const audioUrl = pickAudioUrl(row)
  return {
    id: String(row?.id || row?.track_id || crypto.randomUUID()),
    title: String(row?.title || row?.name || row?.track_title || "Bez tytułu"),
    artistName: String(pickArtistName(row)),
    genre: row?.genre || row?.genre_slug || row?.category || null,
    audioUrl,
    coverUrl: pickCoverUrl(row),
    createdAt: row?.created_at || row?.createdAt || null,
    status: row?.status || null,
  }
}

function explainError(err) {
  return {
    name: err?.name || null,
    message: err?.message || String(err),
    code: err?.code || err?.cause?.code || null,
    errno: err?.errno || err?.cause?.errno || null,
    syscall: err?.syscall || err?.cause?.syscall || null,
    hostname: err?.hostname || err?.cause?.hostname || null,
    causeMessage: err?.cause?.message || null,
  }
}

function buildSupabaseRestUrl(restPath) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  }

  if (!SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.startsWith("http://")) {
    throw new Error(`Invalid SUPABASE_URL: ${SUPABASE_URL || "EMPTY"}`)
  }

  return `${SUPABASE_URL}${restPath}`
}

async function supabaseRestFetch(restPath, options = {}) {
  const url = buildSupabaseRestUrl(restPath)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/json",
        ...(options.headers || {}),
      },
    })

    const text = await res.text()
    let json = null

    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }

    if (!res.ok) {
      throw new Error(`Supabase REST fetch ${res.status}: ${text.slice(0, 900)}`)
    }

    return json
  } finally {
    clearTimeout(timeoutId)
  }
}

function supabaseRestHttps(restPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(buildSupabaseRestUrl(restPath))

    const req = https.request(
      {
        method: options.method || "GET",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        family: 4,
        timeout: 15000,
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = []

        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json = null

          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Supabase REST https ${res.statusCode}: ${text.slice(0, 900)}`))
            return
          }

          resolve(json)
        })
      }
    )

    req.on("timeout", () => req.destroy(new Error("HTTPS request timeout")))
    req.on("error", reject)
    req.end()
  })
}

async function supabaseRest(restPath, options = {}) {
  try {
    return await supabaseRestFetch(restPath, options)
  } catch (fetchErr) {
    console.warn("[CoreSound Radio Server] global fetch failed; trying https fallback:", explainError(fetchErr))

    try {
      return await supabaseRestHttps(restPath, options)
    } catch (httpsErr) {
      throw new Error(
        `fetch=${JSON.stringify(explainError(fetchErr))}; https=${JSON.stringify(explainError(httpsErr))}`
      )
    }
  }
}

function shuffleTracks(input) {
  const arr = [...input]

  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }

  return arr
}

function isPlayableStatus(status) {
  const clean = String(status || "").trim().toLowerCase()

  if (!clean) return true

  return ["active", "published", "visible", "approved", "public", "live"].includes(clean)
}

async function fetchRowsFromTracks() {
  const baseParams = new URLSearchParams()
  baseParams.set("select", "*")
  baseParams.set("limit", String(MAX_TRACKS))
  baseParams.set("order", "created_at.desc")

  try {
    return await supabaseRest(`/rest/v1/tracks?${baseParams.toString()}&status=in.(active,published,visible,approved,public,live)`)
  } catch (err) {
    console.warn("[CoreSound Radio Server] filtered tracks fetch warning:", err?.message || err)
  }

  try {
    return await supabaseRest(`/rest/v1/tracks?${baseParams.toString()}`)
  } catch (err) {
    console.warn("[CoreSound Radio Server] ordered tracks fetch warning:", err?.message || err)
  }

  const fallbackParams = new URLSearchParams()
  fallbackParams.set("select", "*")
  fallbackParams.set("limit", String(MAX_TRACKS))

  return await supabaseRest(`/rest/v1/tracks?${fallbackParams.toString()}`)
}

async function fetchTracksFromSupabase({ force = false } = {}) {
  const now = Date.now()

  if (!force && cachedTracks.length > 0 && now - lastTracksFetchAt < 60_000) {
    return cachedTracks
  }

  const rows = await fetchRowsFromTracks()

  const tracks = (Array.isArray(rows) ? rows : [])
    .filter((row) => isPlayableStatus(row?.status))
    .map(mapTrack)
    .filter((track) => track.id && track.audioUrl)

  if (tracks.length === 0) {
    throw new Error("No playable tracks found in Supabase tracks table. Check if rows have stream_url/audio URL field and active/visible status.")
  }

  cachedTracks = shuffleTracks(tracks)
  lastTracksFetchAt = now
  lastTracksError = null

  return cachedTracks
}

async function getCurrentTrack() {
  const tracks = await fetchTracksFromSupabase()

  if (currentTrackIndex >= tracks.length) currentTrackIndex = 0

  const track = tracks[currentTrackIndex]
  if (!track) throw new Error("No current track available")

  return { track, poolSize: tracks.length, index: currentTrackIndex }
}

function advanceTrack() {
  if (cachedTracks.length === 0) return

  currentTrackIndex += 1

  if (currentTrackIndex >= cachedTracks.length) {
    cachedTracks = shuffleTracks(cachedTracks)
    currentTrackIndex = 0
  }
}

function escapeFfconcatPath(value) {
  return String(value || "").replace(/'/g, "'\\''")
}

async function checkTrackPlayableForFfmpeg(track) {
  const audioUrl = String(track?.audioUrl || "").trim()
  if (!audioUrl) {
    return { ok: false, reason: "empty_audio_url" }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS)

  try {
    const res = await fetch(audioUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Range: "bytes=0-4095",
        "User-Agent": "CoreSoundRadioServer/1.0",
        Accept: "audio/*,*/*",
      },
    })

    const contentType = String(res.headers.get("content-type") || "").toLowerCase()
    const finalUrl = String(res.url || audioUrl)

    if (!res.ok && res.status !== 206) {
      return {
        ok: false,
        reason: `http_${res.status}`,
        contentType,
        finalUrl,
      }
    }

    if (contentType.includes("text/html")) {
      return {
        ok: false,
        reason: "html_instead_of_audio",
        contentType,
        finalUrl,
      }
    }

    const looksAudio =
      contentType.includes("audio") ||
      contentType.includes("mpeg") ||
      contentType.includes("octet-stream") ||
      /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(finalUrl) ||
      /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(audioUrl)

    if (!looksAudio) {
      return {
        ok: false,
        reason: `not_audio_content_type_${contentType || "empty"}`,
        contentType,
        finalUrl,
      }
    }

    try {
      await res.body?.cancel?.()
    } catch {}

    return {
      ok: true,
      contentType,
      finalUrl,
    }
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === "AbortError" ? "timeout" : (err?.message || String(err)),
      code: err?.code || err?.cause?.code || null,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function filterPlayableTracksForFfmpeg(tracks) {
  const now = Date.now()

  if (cachedFfmpegValidTracks.length > 0 && now - lastFfmpegValidTracksAt < VALID_TRACKS_CACHE_MS) {
    return cachedFfmpegValidTracks
  }

  const shuffled = shuffleTracks(tracks).slice(0, Math.min(tracks.length, MAX_FFMPEG_PLAYLIST_TRACKS))
  const valid = []
  const skipped = []
  const concurrency = 8
  let index = 0

  async function worker() {
    while (index < shuffled.length) {
      const current = shuffled[index]
      index += 1

      const result = await checkTrackPlayableForFfmpeg(current)

      if (result.ok) {
        valid.push({
          ...current,
          audioUrl: result.finalUrl || current.audioUrl,
        })
      } else {
        skipped.push({
          id: current.id,
          title: current.title,
          artistName: current.artistName,
          reason: result.reason,
          code: result.code || null,
          contentType: result.contentType || null,
        })
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  lastSkippedBadLinks = skipped.slice(0, 40)

  if (valid.length === 0) {
    throw new Error(`No FFmpeg-playable tracks after link check. Skipped ${skipped.length} links.`)
  }

  cachedFfmpegValidTracks = shuffleTracks(valid)
  lastFfmpegValidTracksAt = Date.now()

  console.log(
    `[CoreSound Radio Server] FFmpeg playlist link check: valid=${cachedFfmpegValidTracks.length}, skipped=${skipped.length}`
  )

  if (skipped.length > 0) {
    console.warn("[CoreSound Radio Server] skipped bad links sample:", JSON.stringify(lastSkippedBadLinks.slice(0, 8)))
  }

  return cachedFfmpegValidTracks
}

function buildLongFfconcatPlaylist(tracks) {
  const lines = ["ffconcat version 1.0"]
  let list = shuffleTracks(tracks)

  for (let repeat = 0; repeat < PLAYLIST_REPEAT_COUNT; repeat += 1) {
    if (repeat > 0) list = shuffleTracks(tracks)

    for (const track of list) {
      if (!track.audioUrl) continue
      lines.push(`file '${escapeFfconcatPath(track.audioUrl)}'`)
    }
  }

  return `${lines.join("\n")}\n`
}

function startFfmpegContinuousStream(req, res, tracks) {
  return new Promise((resolve, reject) => {
    const playlistId = crypto.randomUUID()
    const playlistPath = path.join(os.tmpdir(), `coresound-${playlistId}.ffconcat`)
    const playlistContent = buildLongFfconcatPlaylist(tracks)

    fs.writeFileSync(playlistPath, playlistContent, "utf8")

    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostdin",
      "-re",
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      playlistPath,
      "-vn",
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "libmp3lame",
      "-b:a",
      STREAM_BITRATE,
      "-f",
      "mp3",
      "pipe:1",
    ]

    console.log(`[CoreSound Radio Server] starting ffmpeg stream with ${tracks.length} checked tracks, playlist ${playlistPath}`)

    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let settled = false
    let stderrBuffer = ""

    const cleanup = () => {
      try {
        fs.unlinkSync(playlistPath)
      } catch {}
    }

    const stop = () => {
      try {
        ffmpeg.kill("SIGTERM")
      } catch {}

      cleanup()
    }

    req.on("close", stop)
    req.on("aborted", stop)
    res.on("close", stop)

    ffmpeg.stderr.on("data", (chunk) => {
      const text = Buffer.from(chunk).toString("utf8")
      stderrBuffer += text
      if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000)
      console.warn("[CoreSound Radio Server] ffmpeg:", text.trim())
    })

    ffmpeg.on("error", (err) => {
      cleanup()
      if (!settled) {
        settled = true
        reject(err)
      }
    })

    ffmpeg.on("close", (code) => {
      cleanup()

      if (!settled && code !== 0) {
        settled = true
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrBuffer.slice(-1000)}`))
        return
      }

      if (!settled) {
        settled = true
        resolve()
      }
    })

    res.status(200)
    res.setHeader("Content-Type", "audio/mpeg")
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.setHeader("X-CoreSound-Version", VERSION)
    res.setHeader("X-CoreSound-Mode", "ffmpeg-continuous-skip-bad-links")
    res.flushHeaders?.()

    ffmpeg.stdout.on("data", (chunk) => {
      if (!res.write(chunk)) {
        ffmpeg.stdout.pause()
        res.once("drain", () => ffmpeg.stdout.resume())
      }
    })

    ffmpeg.stdout.on("end", () => {
      try {
        res.end()
      } catch {}
    })
  })
}

async function dnsProbe() {
  const hostname = SUPABASE_URL ? new URL(SUPABASE_URL).hostname : ""
  const out = { hostname, ipv4: null, ipv6: null, errors: [] }

  if (!hostname) return out

  try {
    out.ipv4 = await dns.promises.resolve4(hostname)
  } catch (err) {
    out.errors.push({ resolve4: explainError(err) })
  }

  try {
    out.ipv6 = await dns.promises.resolve6(hostname)
  } catch (err) {
    out.errors.push({ resolve6: explainError(err) })
  }

  return out
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "coresound-radio-server",
    version: VERSION,
    mode: "ffmpeg-continuous-mp3-skip-bad-links",
    time: new Date().toISOString(),
  })
})

app.get("/debug", async (_req, res) => {
  const debug = {
    ok: true,
    version: VERSION,
    node: process.version,
    supabaseUrlPresent: Boolean(SUPABASE_URL),
    supabaseUrlPreview: SUPABASE_URL ? `${SUPABASE_URL.slice(0, 35)}...` : null,
    serviceKeyPresent: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    serviceKeyPrefix: SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.slice(0, 12) : null,
    ffmpegExpected: true,
    cachedTracks: cachedTracks.length,
    cachedFfmpegValidTracks: cachedFfmpegValidTracks.length,
    lastFfmpegValidTracksAt: lastFfmpegValidTracksAt ? new Date(lastFfmpegValidTracksAt).toISOString() : null,
    lastSkippedBadLinks,
    linkCheckTimeoutMs: LINK_CHECK_TIMEOUT_MS,
    maxFfmpegPlaylistTracks: MAX_FFMPEG_PLAYLIST_TRACKS,
    lastTracksFetchAt: lastTracksFetchAt ? new Date(lastTracksFetchAt).toISOString() : null,
    lastTracksError,
  }

  try {
    debug.dns = await dnsProbe()
  } catch (err) {
    debug.dns = { ok: false, error: explainError(err) }
  }

  try {
    const rows = await supabaseRest("/rest/v1/tracks?select=*&limit=1")
    debug.restTest = { ok: true, rows }
  } catch (err) {
    debug.ok = false
    debug.restTest = { ok: false, error: err?.message || String(err) }
  }

  res.json(debug)
})

app.get("/now", async (_req, res) => {
  try {
    const { track, poolSize, index } = await getCurrentTrack()
    res.json({
      ok: true,
      version: VERSION,
      mode: "ffmpeg-continuous-mp3-skip-bad-links",
      track,
      poolSize,
      index,
    })
  } catch (err) {
    lastTracksError = err?.message || String(err)
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: `Supabase tracks fetch failed: ${lastTracksError}`,
    })
  }
})

app.post("/admin/refresh", async (_req, res) => {
  try {
    const tracks = await fetchTracksFromSupabase({ force: true })
    cachedFfmpegValidTracks = []
    lastFfmpegValidTracksAt = 0
    currentTrackIndex = 0
    res.json({ ok: true, version: VERSION, poolSize: tracks.length })
  } catch (err) {
    lastTracksError = err?.message || String(err)
    res.status(500).json({ ok: false, version: VERSION, error: lastTracksError })
  }
})

app.post("/admin/skip", (_req, res) => {
  advanceTrack()
  res.json({ ok: true, version: VERSION, nextIndex: currentTrackIndex })
})

app.get("/live", async (req, res) => {
  try {
    const allTracks = await fetchTracksFromSupabase()

    if (allTracks.length === 0) {
      throw new Error("No tracks available for continuous stream")
    }

    const tracks = await filterPlayableTracksForFfmpeg(allTracks)
    await startFfmpegContinuousStream(req, res, tracks)
  } catch (err) {
    console.warn("[CoreSound Radio Server] ffmpeg live stream warning:", err?.message || err)
    lastTracksError = err?.message || String(err)

    if (!res.headersSent) {
      res.status(500).json({ ok: false, version: VERSION, error: lastTracksError })
    } else {
      try {
        res.end()
      } catch {}
    }
  }
})

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: "Not found",
  })
})

app.listen(PORT, () => {
  console.log(`[CoreSound Radio Server] ${VERSION} listening on ${PORT}`)
  console.log(`[CoreSound Radio Server] SUPABASE_URL present: ${Boolean(SUPABASE_URL)}`)
})