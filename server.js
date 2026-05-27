import dns from "node:dns"
import https from "node:https"
import express from "express"
import cors from "cors"

dns.setDefaultResultOrder("ipv4first")

const VERSION = "v5-network-fallback-2026-05-27"
const PORT = Number.parseInt(process.env.PORT || "3000", 10)
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "")
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"
const MAX_TRACKS = 500

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
    const isDropbox = url.hostname === "dropbox.com" || url.hostname === "www.dropbox.com" || url.hostname === "dl.dropboxusercontent.com"
    if (!isDropbox) return raw
    if (url.hostname === "dropbox.com" || url.hostname === "www.dropbox.com") url.hostname = "dl.dropboxusercontent.com"
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
  return normalizeAudioUrl(row?.audio_url || row?.stream_url || row?.file_url || row?.url || row?.audioUrl || row?.streamUrl || "")
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

function buildSupabaseRestUrl(path) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  if (!SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.startsWith("http://")) {
    throw new Error(`Invalid SUPABASE_URL: ${SUPABASE_URL || "EMPTY"}`)
  }
  return `${SUPABASE_URL}${path}`
}

async function supabaseRestFetch(path, options = {}) {
  const url = buildSupabaseRestUrl(path)
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
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) throw new Error(`Supabase REST fetch ${res.status}: ${text.slice(0, 700)}`)
    return json
  } finally {
    clearTimeout(timeoutId)
  }
}

function supabaseRestHttps(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(buildSupabaseRestUrl(path))
    const req = https.request({
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
    }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { json = null }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Supabase REST https ${res.statusCode}: ${text.slice(0, 700)}`))
          return
        }
        resolve(json)
      })
    })
    req.on("timeout", () => req.destroy(new Error("HTTPS request timeout")))
    req.on("error", reject)
    req.end()
  })
}

async function supabaseRest(path, options = {}) {
  try {
    return await supabaseRestFetch(path, options)
  } catch (fetchErr) {
    console.warn("[CoreSound Radio Server] global fetch failed; trying https fallback:", explainError(fetchErr))
    try {
      return await supabaseRestHttps(path, options)
    } catch (httpsErr) {
      throw new Error(`fetch=${JSON.stringify(explainError(fetchErr))}; https=${JSON.stringify(explainError(httpsErr))}`)
    }
  }
}

async function fetchTracksFromSupabase({ force = false } = {}) {
  const now = Date.now()
  if (!force && cachedTracks.length > 0 && now - lastTracksFetchAt < 60000) return cachedTracks

  const columns = ["id","title","genre","status","audio_url","stream_url","file_url","url","cover_url","avatar_url","image_url","created_at","artist_name"].join(",")
  const params = new URLSearchParams()
  params.set("select", columns)
  params.set("limit", String(MAX_TRACKS))
  params.set("order", "created_at.desc")

  let rows = []
  try {
    rows = await supabaseRest(`/rest/v1/tracks?${params.toString()}&status=in.(active,published,visible,approved,public)`)
  } catch (err) {
    console.warn("[CoreSound Radio Server] filtered tracks fetch warning:", err?.message || err)
    rows = await supabaseRest(`/rest/v1/tracks?${params.toString()}`)
  }

  const tracks = (Array.isArray(rows) ? rows : []).map(mapTrack).filter((t) => t.id && t.audioUrl)
  if (tracks.length === 0) throw new Error("No playable tracks found in Supabase tracks table")
  cachedTracks = shuffleTracks(tracks)
  lastTracksFetchAt = now
  lastTracksError = null
  return cachedTracks
}

function shuffleTracks(input) {
  const arr = [...input]
  for (let i = arr.length - 1; i > 0; i--) {
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
  if (!cachedTracks.length) return
  currentTrackIndex += 1
  if (currentTrackIndex >= cachedTracks.length) {
    cachedTracks = shuffleTracks(cachedTracks)
    currentTrackIndex = 0
  }
}

async function streamRemoteAudio(req, res, track) {
  const headers = {}
  if (req.headers.range) headers.Range = req.headers.range
  const upstream = await fetch(track.audioUrl, { headers, redirect: "follow" })
  if (!upstream.ok && upstream.status !== 206) throw new Error(`Audio upstream failed ${upstream.status} for track ${track.id}`)

  res.status(upstream.status === 206 ? 206 : 200)
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg")
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
  res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes")
  res.setHeader("X-CoreSound-Track-Id", track.id)
  res.setHeader("X-CoreSound-Track-Title", encodeURIComponent(track.title))
  const len = upstream.headers.get("content-length")
  const range = upstream.headers.get("content-range")
  if (len) res.setHeader("Content-Length", len)
  if (range) res.setHeader("Content-Range", range)

  if (!upstream.body) throw new Error("Audio upstream has no body")
  const reader = upstream.body.getReader()
  req.on("close", () => { try { reader.cancel() } catch {} })
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve))
  }
  res.end()
}

async function dnsProbe() {
  const hostname = SUPABASE_URL ? new URL(SUPABASE_URL).hostname : ""
  const out = { hostname, ipv4: null, ipv6: null, errors: [] }
  if (!hostname) return out
  try { out.ipv4 = await dns.promises.resolve4(hostname) } catch (err) { out.errors.push({ resolve4: explainError(err) }) }
  try { out.ipv6 = await dns.promises.resolve6(hostname) } catch (err) { out.errors.push({ resolve6: explainError(err) }) }
  return out
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "coresound-radio-server", version: VERSION, time: new Date().toISOString() })
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
    cachedTracks: cachedTracks.length,
    lastTracksFetchAt: lastTracksFetchAt ? new Date(lastTracksFetchAt).toISOString() : null,
    lastTracksError,
  }
  try { debug.dns = await dnsProbe() } catch (err) { debug.dns = { ok: false, error: explainError(err) } }
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
    res.json({ ok: true, version: VERSION, track, poolSize, index })
  } catch (err) {
    lastTracksError = err?.message || String(err)
    res.status(500).json({ ok: false, version: VERSION, error: `Supabase tracks fetch failed: ${lastTracksError}` })
  }
})

app.post("/admin/refresh", async (_req, res) => {
  try {
    const tracks = await fetchTracksFromSupabase({ force: true })
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
    const { track } = await getCurrentTrack()
    await streamRemoteAudio(req, res, track)
    if (!req.headers.range) advanceTrack()
  } catch (err) {
    console.warn("[CoreSound Radio Server] live stream warning:", err?.message || err)
    lastTracksError = err?.message || String(err)
    if (!res.headersSent) res.status(500).json({ ok: false, version: VERSION, error: lastTracksError })
    else { try { res.end() } catch {} }
  }
})

app.use((_req, res) => res.status(404).json({ ok: false, version: VERSION, error: "Not found" }))

app.listen(PORT, () => {
  console.log(`[CoreSound Radio Server] ${VERSION} listening on ${PORT}`)
  console.log(`[CoreSound Radio Server] SUPABASE_URL present: ${Boolean(SUPABASE_URL)}`)
})
