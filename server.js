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

const VERSION = "v14b-always-on-buffer-guard-2026-05-27"
const PORT = Number.parseInt(process.env.PORT || "8080", 10)
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "")
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"

const MAX_TRACKS = 500
const STREAM_BITRATE = process.env.STREAM_BITRATE || "128k"
const LOCAL_BUFFER_SIZE = Number.parseInt(process.env.LOCAL_BUFFER_SIZE || "4", 10)
const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.DOWNLOAD_TIMEOUT_MS || "45000", 10)
const MAX_DOWNLOAD_BYTES = Number.parseInt(process.env.MAX_DOWNLOAD_BYTES || String(80 * 1024 * 1024), 10)
const LINK_CHECK_TIMEOUT_MS = Number.parseInt(process.env.LINK_CHECK_TIMEOUT_MS || "6500", 10)
const MAX_FFMPEG_PLAYLIST_TRACKS = Number.parseInt(process.env.MAX_FFMPEG_PLAYLIST_TRACKS || "100", 10)
const VALID_TRACKS_CACHE_MS = Number.parseInt(process.env.VALID_TRACKS_CACHE_MS || "300000", 10)
const ALWAYS_ON_RADIO = String(process.env.ALWAYS_ON_RADIO || "true").toLowerCase() !== "false"
const RADIO_START_DELAY_MS = Number.parseInt(process.env.RADIO_START_DELAY_MS || "3000", 10)
const BUFFER_FILL_MAX_ATTEMPTS = Number.parseInt(process.env.BUFFER_FILL_MAX_ATTEMPTS || "40", 10)
const BROADCAST_RESTART_DELAY_MS = Number.parseInt(process.env.BROADCAST_RESTART_DELAY_MS || "5000", 10)

const app = express()
app.use(cors({ origin: ALLOWED_ORIGIN }))
app.use(express.json({ limit: "1mb" }))

let cachedTracks = []
let lastTracksFetchAt = 0
let lastTracksError = null
let cachedFfmpegValidTracks = []
let lastFfmpegValidTracksAt = 0
let lastSkippedBadLinks = []

const clients = new Map()
let clientCounter = 0
let broadcastRunning = false
let broadcastStopRequested = false
let broadcastStartedAt = null
let currentBroadcastTrack = null
let currentBroadcastTrackStartedAt = null
let currentFfmpeg = null
let broadcastLoopPromise = null

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
  if (!force && cachedTracks.length > 0 && now - lastTracksFetchAt < 60_000) return cachedTracks

  const rows = await fetchRowsFromTracks()
  const tracks = (Array.isArray(rows) ? rows : [])
    .filter((row) => isPlayableStatus(row?.status))
    .map(mapTrack)
    .filter((track) => track.id && track.audioUrl)

  if (tracks.length === 0) {
    throw new Error("No playable tracks found in Supabase tracks table. Check stream_url/audio URL field and active/visible status.")
  }

  cachedTracks = shuffleTracks(tracks)
  lastTracksFetchAt = now
  lastTracksError = null
  return cachedTracks
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

async function checkTrackPlayableForFfmpeg(track) {
  const audioUrl = String(track?.audioUrl || "").trim()
  if (!audioUrl) return { ok: false, reason: "empty_audio_url" }

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
      return { ok: false, reason: `http_${res.status}`, contentType, finalUrl }
    }

    if (contentType.includes("text/html")) {
      return { ok: false, reason: "html_instead_of_audio", contentType, finalUrl }
    }

    const looksAudio =
      contentType.includes("audio") ||
      contentType.includes("mpeg") ||
      contentType.includes("octet-stream") ||
      /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(finalUrl) ||
      /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(audioUrl)

    if (!looksAudio) {
      return { ok: false, reason: `not_audio_content_type_${contentType || "empty"}`, contentType, finalUrl }
    }

    try {
      await res.body?.cancel?.()
    } catch {}

    return { ok: true, contentType, finalUrl }
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === "AbortError" ? "timeout" : err?.message || String(err),
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
        valid.push({ ...current, audioUrl: result.finalUrl || current.audioUrl })
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

  console.log(`[CoreSound Radio Server] FFmpeg playlist link check: valid=${valid.length}, skipped=${skipped.length}`)
  if (skipped.length > 0) {
    console.warn("[CoreSound Radio Server] skipped bad links sample:", JSON.stringify(lastSkippedBadLinks.slice(0, 8)))
  }

  return cachedFfmpegValidTracks
}

async function downloadTrackToTmp(track) {
  const audioUrl = String(track?.audioUrl || "").trim()
  if (!audioUrl) throw new Error("empty_audio_url")

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const fileId = crypto.randomUUID()
  const filePath = path.join(os.tmpdir(), `coresound-track-${fileId}.audio`)

  try {
    console.log(`[CoreSound Radio Server] downloading to local cache: ${track.title} / ${track.id}`)

    const res = await fetch(audioUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "CoreSoundRadioServer/1.0",
        Accept: "audio/*,*/*",
      },
    })

    const contentType = String(res.headers.get("content-type") || "").toLowerCase()
    if (!res.ok) throw new Error(`download_http_${res.status}`)
    if (contentType.includes("text/html")) throw new Error("download_html_instead_of_audio")
    if (!res.body) throw new Error("download_empty_body")

    const tmpWrite = fs.createWriteStream(filePath)
    const reader = res.body.getReader()
    let total = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      total += value.byteLength
      if (total > MAX_DOWNLOAD_BYTES) {
        try { await reader.cancel() } catch {}
        throw new Error(`download_too_large_${total}`)
      }

      if (!tmpWrite.write(Buffer.from(value))) {
        await new Promise((resolve) => tmpWrite.once("drain", resolve))
      }
    }

    await new Promise((resolve, reject) => {
      tmpWrite.end((err) => err ? reject(err) : resolve())
    })

    const stat = fs.statSync(filePath)
    if (!stat.size || stat.size < 1024) throw new Error(`download_too_small_${stat.size}`)

    return { ...track, localPath: filePath, localSize: stat.size, downloadedAt: new Date().toISOString() }
  } catch (err) {
    try { fs.unlinkSync(filePath) } catch {}
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

function deleteLocalTrack(localTrack) {
  const localPath = localTrack?.localPath
  if (!localPath) return
  try { fs.unlinkSync(localPath) } catch {}
}

async function pipeLocalTrackThroughFfmpeg(localTrack) {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-nostdin",
      "-re",
      "-i", localTrack.localPath,
      "-vn",
      "-ac", "2",
      "-ar", "44100",
      "-c:a", "libmp3lame",
      "-b:a", STREAM_BITRATE,
      "-f", "mp3",
      "pipe:1",
    ]

    console.log(`[CoreSound Radio Server] playing local cached track: ${localTrack.title} / ${localTrack.id} / ${localTrack.localSize} bytes`)
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })
    currentFfmpeg = ffmpeg

    let stderrBuffer = ""
    let wroteAnyAudio = false

    ffmpeg.stderr.on("data", (chunk) => {
      const text = Buffer.from(chunk).toString("utf8")
      stderrBuffer += text
      if (stderrBuffer.length > 3000) stderrBuffer = stderrBuffer.slice(-3000)
      console.warn("[CoreSound Radio Server] ffmpeg:", text.trim())
    })

    ffmpeg.stdout.on("data", (chunk) => {
      wroteAnyAudio = true
      broadcastChunk(chunk)
    })

    ffmpeg.on("error", (err) => {
      currentFfmpeg = null
      console.warn(`[CoreSound Radio Server] local ffmpeg spawn error for ${localTrack.id}:`, err?.message || err)
      resolve({ ok: false, wroteAnyAudio, error: err?.message || String(err) })
    })

    ffmpeg.on("close", (code) => {
      currentFfmpeg = null
      if (code === 0 || wroteAnyAudio) {
        resolve({ ok: code === 0, wroteAnyAudio, code })
        return
      }

      console.warn(`[CoreSound Radio Server] local ffmpeg track failed, skipping ${localTrack.id}, code=${code}, stderr=${stderrBuffer.slice(-800)}`)
      resolve({ ok: false, wroteAnyAudio, code, error: stderrBuffer.slice(-800) })
    })
  })
}

function createTrackPicker(tracks) {
  let playlist = shuffleTracks(tracks)
  let index = 0

  return function pickNextTrack() {
    if (playlist.length === 0) return null
    if (index >= playlist.length) {
      playlist = shuffleTracks(tracks)
      index = 0
    }
    const track = playlist[index]
    index += 1
    return track
  }
}

async function fillLocalBuffer(buffer, pickNextTrack, reason = "normal") {
  let attempts = 0
  let successes = 0
  const startedWith = buffer.length

  while (!broadcastStopRequested && buffer.length < LOCAL_BUFFER_SIZE && attempts < BUFFER_FILL_MAX_ATTEMPTS) {
    attempts += 1

    const candidate = pickNextTrack()
    if (!candidate) break

    try {
      const localTrack = await downloadTrackToTmp(candidate)
      buffer.push(localTrack)
      successes += 1
      console.log(
        `[CoreSound Radio Server] local buffer filled: ${buffer.length}/${LOCAL_BUFFER_SIZE}, attempts=${attempts}, reason=${reason}`
      )
    } catch (err) {
      console.warn(
        `[CoreSound Radio Server] download failed, skipping ${candidate?.id || "unknown"}, attempts=${attempts}/${BUFFER_FILL_MAX_ATTEMPTS}:`,
        err?.message || err
      )
    }
  }

  if (buffer.length === startedWith && successes === 0) {
    console.warn(
      `[CoreSound Radio Server] buffer refill made no progress, reason=${reason}, attempts=${attempts}/${BUFFER_FILL_MAX_ATTEMPTS}`
    )
  }

  return {
    ok: buffer.length > startedWith,
    attempts,
    successes,
    bufferSize: buffer.length,
  }
}

function broadcastChunk(chunk) {
  for (const [id, client] of clients.entries()) {
    try {
      if (client.res.destroyed || client.res.writableEnded) {
        clients.delete(id)
        continue
      }
      client.res.write(chunk)
    } catch {
      clients.delete(id)
    }
  }
}

async function ensureBroadcastEngineRunning() {
  if (broadcastRunning || broadcastLoopPromise) return broadcastLoopPromise

  broadcastStopRequested = false
  broadcastRunning = true
  broadcastStartedAt = new Date().toISOString()

  broadcastLoopPromise = runBroadcastLoop()
    .catch((err) => {
      console.warn("[CoreSound Radio Server] broadcast loop crashed:", err?.message || err)
      lastTracksError = err?.message || String(err)
    })
    .finally(() => {
      broadcastRunning = false
      broadcastLoopPromise = null
      currentBroadcastTrack = null
      currentBroadcastTrackStartedAt = null
      currentFfmpeg = null
      broadcastStartedAt = null

      if (ALWAYS_ON_RADIO) {
        setTimeout(() => {
          if (!broadcastRunning && !broadcastLoopPromise) {
            console.log("[CoreSound Radio Server] restarting always-on broadcast engine after stop/crash")
            void ensureBroadcastEngineRunning()
          }
        }, BROADCAST_RESTART_DELAY_MS)
      }
    })

  return broadcastLoopPromise
}

async function runBroadcastLoop() {
  console.log("[CoreSound Radio Server] always-on shared broadcast engine starting")
  let allTracks = await fetchTracksFromSupabase()
  let validTracks = await filterPlayableTracksForFfmpeg(allTracks)
  const localBuffer = []
  let pickNextTrack = createTrackPicker(validTracks)
  let failureStreak = 0

  await fillLocalBuffer(localBuffer, pickNextTrack, "initial")

  while (!broadcastStopRequested) {
    if (localBuffer.length === 0) {
      console.warn("[CoreSound Radio Server] local buffer empty; trying refill")
      await fillLocalBuffer(localBuffer, pickNextTrack, "initial")

      if (localBuffer.length === 0) {
        throw new Error("No locally cached tracks available for always-on broadcast")
      }
    }

    const localTrack = localBuffer.shift()
    void fillLocalBuffer(localBuffer, pickNextTrack, "background").catch((err) => {
      console.warn("[CoreSound Radio Server] background buffer refill warning:", err?.message || err)
    })

    currentBroadcastTrack = {
      id: localTrack.id,
      title: localTrack.title,
      artistName: localTrack.artistName,
      genre: localTrack.genre,
      coverUrl: localTrack.coverUrl,
    }
    currentBroadcastTrackStartedAt = new Date().toISOString()

    try {
      const result = await pipeLocalTrackThroughFfmpeg(localTrack)
      if (result.ok || result.wroteAnyAudio) failureStreak = 0
      else failureStreak += 1
    } finally {
      deleteLocalTrack(localTrack)
    }

    if (failureStreak >= 8) {
      console.warn("[CoreSound Radio Server] too many playback failures; refreshing track cache")
      cachedTracks = []
      cachedFfmpegValidTracks = []
      lastFfmpegValidTracksAt = 0
      allTracks = await fetchTracksFromSupabase({ force: true })
      validTracks = await filterPlayableTracksForFfmpeg(allTracks)
      pickNextTrack = createTrackPicker(validTracks)
      failureStreak = 0
    }
  }

  for (const localTrack of localBuffer) deleteLocalTrack(localTrack)
  console.log("[CoreSound Radio Server] always-on shared broadcast engine stopped")
}

function attachClient(req, res) {
  const id = String(++clientCounter)
  clients.set(id, {
    id,
    res,
    connectedAt: new Date().toISOString(),
    userAgent: req.headers["user-agent"] || null,
  })

  const cleanup = () => {
    clients.delete(id)
  }

  req.on("close", cleanup)
  req.on("aborted", cleanup)
  res.on("close", cleanup)
  return id
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "coresound-radio-server",
    version: VERSION,
    mode: "always-on-shared-broadcast-local-cache-buffer",
    clients: clients.size,
    broadcastRunning,
    currentBroadcastTrack,
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
    alwaysOnRadio: ALWAYS_ON_RADIO,
    radioStartDelayMs: RADIO_START_DELAY_MS,
    broadcastRestartDelayMs: BROADCAST_RESTART_DELAY_MS,
    bufferFillMaxAttempts: BUFFER_FILL_MAX_ATTEMPTS,
    clients: clients.size,
    broadcastRunning,
    broadcastStartedAt,
    currentBroadcastTrack,
    currentBroadcastTrackStartedAt,
    cachedTracks: cachedTracks.length,
    cachedFfmpegValidTracks: cachedFfmpegValidTracks.length,
    lastFfmpegValidTracksAt: lastFfmpegValidTracksAt ? new Date(lastFfmpegValidTracksAt).toISOString() : null,
    lastSkippedBadLinks,
    localBufferSize: LOCAL_BUFFER_SIZE,
    downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    linkCheckTimeoutMs: LINK_CHECK_TIMEOUT_MS,
    maxFfmpegPlaylistTracks: MAX_FFMPEG_PLAYLIST_TRACKS,
    lastTracksFetchAt: lastTracksFetchAt ? new Date(lastTracksFetchAt).toISOString() : null,
    lastTracksError,
  }

  try { debug.dns = await dnsProbe() } catch (err) { debug.dns = { ok: false, error: explainError(err) } }

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
    if (!broadcastRunning) void ensureBroadcastEngineRunning()

    res.json({
      ok: true,
      version: VERSION,
      mode: "always-on-shared-broadcast-local-cache-buffer",
      clients: clients.size,
      broadcastRunning,
      broadcastStartedAt,
      track: currentBroadcastTrack,
      trackStartedAt: currentBroadcastTrackStartedAt,
      cachedTracks: cachedTracks.length,
      cachedFfmpegValidTracks: cachedFfmpegValidTracks.length,
    })
  } catch (err) {
    lastTracksError = err?.message || String(err)
    res.status(500).json({ ok: false, version: VERSION, error: lastTracksError })
  }
})

app.post("/admin/refresh", async (_req, res) => {
  try {
    cachedTracks = []
    cachedFfmpegValidTracks = []
    lastFfmpegValidTracksAt = 0
    const tracks = await fetchTracksFromSupabase({ force: true })
    res.json({ ok: true, version: VERSION, poolSize: tracks.length })
  } catch (err) {
    lastTracksError = err?.message || String(err)
    res.status(500).json({ ok: false, version: VERSION, error: lastTracksError })
  }
})

app.post("/admin/restart", (_req, res) => {
  broadcastStopRequested = true
  try { currentFfmpeg?.kill("SIGTERM") } catch {}
  setTimeout(() => void ensureBroadcastEngineRunning(), 500)
  res.json({ ok: true, version: VERSION, message: "Broadcast restart requested." })
})

app.get("/live", async (req, res) => {
  res.status(200)
  res.setHeader("Content-Type", "audio/mpeg")
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  res.setHeader("X-CoreSound-Version", VERSION)
  res.setHeader("X-CoreSound-Mode", "always-on-shared-broadcast-local-cache-buffer")
  res.flushHeaders?.()

  const id = attachClient(req, res)
  console.log(`[CoreSound Radio Server] client ${id} connected. listeners=${clients.size}`)
  void ensureBroadcastEngineRunning()
})

app.use((_req, res) => {
  res.status(404).json({ ok: false, version: VERSION, error: "Not found" })
})

app.listen(PORT, () => {
  console.log(`[CoreSound Radio Server] ${VERSION} listening on ${PORT}`)
  console.log(`[CoreSound Radio Server] SUPABASE_URL present: ${Boolean(SUPABASE_URL)}`)
  console.log(`[CoreSound Radio Server] ALWAYS_ON_RADIO: ${ALWAYS_ON_RADIO}`)

  if (ALWAYS_ON_RADIO) {
    setTimeout(() => {
      console.log("[CoreSound Radio Server] auto-starting always-on broadcast engine")
      void ensureBroadcastEngineRunning()
    }, RADIO_START_DELAY_MS)
  }
})
