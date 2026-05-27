import dns from "node:dns"
import express from "express"
import cors from "cors"

// Railway/Supabase sometimes behaves better with IPv4-first DNS resolution.
dns.setDefaultResultOrder("ipv4first")

const PORT = Number.parseInt(process.env.PORT || "3000", 10)
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "")
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"
const DEFAULT_SLOT_SECONDS = 210
const MAX_TRACKS = 500

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[CoreSound Radio Server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
}

const app = express()
app.use(cors({ origin: ALLOWED_ORIGIN }))
app.use(express.json({ limit: "1mb" }))

let cachedTracks = []
let lastTracksFetchAt = 0
let lastTracksError = null
let currentTrackIndex = 0

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

function pickAudioUrl(row) {
  return normalizeAudioUrl(
    row?.audio_url ||
      row?.stream_url ||
      row?.file_url ||
      row?.url ||
      row?.audioUrl ||
      row?.streamUrl ||
      ""
  )
}

function mapTrack(row) {
  const audioUrl = pickAudioUrl(row)
  return {
    id: String(row.id),
    title: String(row.title || row.name || "Bez tytułu"),
    artistName: String(row.artist_name || row.artistName || row.artist || "CoreSound"),
    genre: row.genre || null,
    audioUrl,
    coverUrl: row.cover_url || row.avatar_url || row.image_url || null,
    createdAt: row.created_at || null,
  }
}

async function supabaseRest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  }

  const url = `${SUPABASE_URL}${path}`
  const res = await fetch(url, {
    ...options,
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
    throw new Error(`Supabase REST ${res.status}: ${text.slice(0, 500)}`)
  }

  return json
}

async function fetchTracksFromSupabase({ force = false } = {}) {
  const now = Date.now()
  if (!force && cachedTracks.length > 0 && now - lastTracksFetchAt < 60_000) {
    return cachedTracks
  }

  const columns = [
    "id",
    "title",
    "genre",
    "status",
    "audio_url",
    "stream_url",
    "file_url",
    "url",
    "cover_url",
    "avatar_url",
    "image_url",
    "created_at",
    "artist_name",
  ].join(",")

  const params = new URLSearchParams()
  params.set("select", columns)
  params.set("limit", String(MAX_TRACKS))
  params.set("order", "created_at.desc")

  // Prefer active/visible/published tracks, but stay tolerant if status values differ.
  const statusFilter = "status.in.(active,published,visible,approved,public)"
  const path = `/rest/v1/tracks?${params.toString()}&${statusFilter}`

  let rows = []
  try {
    rows = await supabaseRest(path)
  } catch (err) {
    // Fallback for schemas where status differs or is missing/unexpected.
    console.warn("[CoreSound Radio Server] filtered tracks fetch warning:", err?.message || err)
    const fallbackParams = new URLSearchParams()
    fallbackParams.set("select", columns)
    fallbackParams.set("limit", String(MAX_TRACKS))
    fallbackParams.set("order", "created_at.desc")
    rows = await supabaseRest(`/rest/v1/tracks?${fallbackParams.toString()}`)
  }

  const tracks = (Array.isArray(rows) ? rows : [])
    .map(mapTrack)
    .filter((track) => track.id && track.audioUrl)

  if (tracks.length === 0) {
    throw new Error("No playable tracks found in Supabase tracks table")
  }

  cachedTracks = shuffleTracks(tracks)
  lastTracksFetchAt = now
  lastTracksError = null
  return cachedTracks
}

function shuffleTracks(input) {
  const arr = [...input]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
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

async function streamRemoteAudio(req, res, track) {
  const upstreamHeaders = {}
  if (req.headers.range) upstreamHeaders.Range = req.headers.range

  const upstream = await fetch(track.audioUrl, {
    headers: upstreamHeaders,
    redirect: "follow",
  })

  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`Audio upstream failed ${upstream.status} for track ${track.id}`)
  }

  const contentType = upstream.headers.get("content-type") || "audio/mpeg"
  const contentLength = upstream.headers.get("content-length")
  const contentRange = upstream.headers.get("content-range")
  const acceptRanges = upstream.headers.get("accept-ranges") || "bytes"

  res.status(upstream.status === 206 ? 206 : 200)
  res.setHeader("Content-Type", contentType)
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
  res.setHeader("Accept-Ranges", acceptRanges)
  res.setHeader("X-CoreSound-Track-Id", track.id)
  res.setHeader("X-CoreSound-Track-Title", encodeURIComponent(track.title))
  if (contentLength) res.setHeader("Content-Length", contentLength)
  if (contentRange) res.setHeader("Content-Range", contentRange)

  if (!upstream.body) throw new Error("Audio upstream has no body")

  const reader = upstream.body.getReader()
  req.on("close", () => {
    try { reader.cancel() } catch {}
  })

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!res.write(Buffer.from(value))) {
      await new Promise((resolve) => res.once("drain", resolve))
    }
  }
  res.end()
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "coresound-radio-server", time: new Date().toISOString() })
})

app.get("/debug", async (_req, res) => {
  const debug = {
    ok: true,
    node: process.version,
    supabaseUrlPresent: Boolean(SUPABASE_URL),
    supabaseUrlPreview: SUPABASE_URL ? `${SUPABASE_URL.slice(0, 25)}...` : null,
    serviceKeyPresent: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    serviceKeyPrefix: SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.slice(0, 12) : null,
    cachedTracks: cachedTracks.length,
    lastTracksFetchAt: lastTracksFetchAt ? new Date(lastTracksFetchAt).toISOString() : null,
    lastTracksError,
  }

  try {
    const rows = await supabaseRest("/rest/v1/tracks?select=id,title,status&limit=1")
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
    res.json({ ok: true, track, poolSize, index })
  } catch (err) {
    lastTracksError = err?.message || String(err)
    res.status(500).json({ ok: false, error: `Supabase tracks fetch failed: ${lastTracksError}` })
  }
})

app.post("/admin/refresh", async (_req, res) => {
  try {
    const tracks = await fetchTracksFromSupabase({ force: true })
    currentTrackIndex = 0
    res.json({ ok: true, poolSize: tracks.length })
  } catch (err) {
    lastTracksError = err?.message || String(err)
    res.status(500).json({ ok: false, error: lastTracksError })
  }
})

app.post("/admin/skip", (_req, res) => {
  advanceTrack()
  res.json({ ok: true, nextIndex: currentTrackIndex })
})

app.get("/live", async (req, res) => {
  try {
    const { track } = await getCurrentTrack()
    await streamRemoteAudio(req, res, track)

    // Move to the next track after a completed non-range request.
    if (!req.headers.range) {
      advanceTrack()
    }
  } catch (err) {
    console.warn("[CoreSound Radio Server] live stream warning:", err?.message || err)
    lastTracksError = err?.message || String(err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: lastTracksError })
    } else {
      try { res.end() } catch {}
    }
  }
})

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" })
})

app.listen(PORT, () => {
  console.log(`[CoreSound Radio Server] listening on ${PORT}`)
  console.log(`[CoreSound Radio Server] SUPABASE_URL present: ${Boolean(SUPABASE_URL)}`)
})
