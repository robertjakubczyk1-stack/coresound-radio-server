import dns from "node:dns"
import express from "express"
import cors from "cors"
import { createClient } from "@supabase/supabase-js"

dns.setDefaultResultOrder("ipv4first")

const PORT = Number.parseInt(process.env.PORT || "3001", 10)
const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"
const DEFAULT_SLOT_SECONDS = 210
const MAX_TRACKS = 500
const CONFIG_KEY = "main"

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[CoreSound Radio Server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
}

function safeErrorDetails(error) {
  const cause = error?.cause || {}
  return {
    message: String(error?.message || error),
    name: error?.name || null,
    code: cause?.code || error?.code || null,
    errno: cause?.errno || null,
    syscall: cause?.syscall || null,
    hostname: cause?.hostname || null,
  }
}

function safeSupabaseInfo() {
  let host = null
  try {
    host = SUPABASE_URL ? new URL(SUPABASE_URL).hostname : null
  } catch {
    host = "invalid-url"
  }

  return {
    supabaseUrlPresent: Boolean(SUPABASE_URL),
    supabaseUrlHost: host,
    serviceRoleKeyPresent: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    serviceRoleKeyPrefix: SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.slice(0, 10) : null,
    nodeVersion: process.version,
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const app = express()
app.disable("x-powered-by")
app.use(cors({ origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN }))

let cachedProgram = null
let cachedAt = 0
const PROGRAM_CACHE_MS = 30_000

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

function audioUrlFromTrack(track) {
  return normalizeAudioUrl(
    track?.stream_url ||
      track?.streamUrl ||
      track?.url ||
      track?.audio_url ||
      track?.audioUrl ||
      track?.file_url ||
      track?.fileUrl ||
      "",
  )
}

function artistNameFromTrack(track) {
  return (
    track?.artists?.name ||
    track?.artist?.name ||
    track?.artist_name ||
    track?.artistName ||
    track?.artist ||
    "Nieznany twórca"
  )
}

function artistAvatarFromTrack(track) {
  return normalizeAudioUrl(
    track?.artists?.avatar_url ||
      track?.artist?.avatar_url ||
      track?.artist_avatar_url ||
      track?.avatar_url ||
      track?.avatar ||
      track?.cover_url ||
      track?.cover ||
      "",
  )
}

function normalizeKey(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function hashString(input) {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function deterministicShuffle(items, seed) {
  return [...items].sort((a, b) => {
    const aHash = hashString(`${seed}:${a.id}`)
    const bHash = hashString(`${seed}:${b.id}`)
    if (aHash !== bHash) return aHash - bHash
    return String(a.id).localeCompare(String(b.id))
  })
}

function improveArtistMix(items) {
  const mixed = [...items]
  for (let index = 1; index < mixed.length; index += 1) {
    if (mixed[index].artistKey !== mixed[index - 1].artistKey) continue
    const swapIndex = mixed.findIndex(
      (item, candidateIndex) => candidateIndex > index && item.artistKey !== mixed[index - 1].artistKey,
    )
    if (swapIndex > index) {
      const temp = mixed[index]
      mixed[index] = mixed[swapIndex]
      mixed[swapIndex] = temp
    }
  }
  return mixed
}

function getSlotSeconds() {
  const fromEnv = Number.parseInt(process.env.CORESOUND_RADIO_SLOT_SECONDS || "", 10)
  return Number.isFinite(fromEnv) && fromEnv >= 60 ? fromEnv : DEFAULT_SLOT_SECONDS
}

async function loadRadioConfig() {
  const fallback = {
    key: CONFIG_KEY,
    mode: "all",
    selected_genres: [],
    shuffle_enabled: true,
    is_active: true,
  }

  const { data, error } = await supabase
    .from("radio_configs")
    .select("key, mode, selected_genres, shuffle_enabled, is_active, updated_at")
    .eq("key", CONFIG_KEY)
    .maybeSingle()

  if (error) {
    if (error.code !== "42P01") {
      console.warn("[CoreSound Radio Server] radio_configs warning:", error.message)
    }
    return fallback
  }

  if (!data) return fallback

  return {
    key: data.key || CONFIG_KEY,
    mode: data.mode === "selected" ? "selected" : "all",
    selected_genres: Array.isArray(data.selected_genres) ? data.selected_genres : [],
    shuffle_enabled: data.shuffle_enabled !== false,
    is_active: data.is_active !== false,
    updated_at: data.updated_at || null,
  }
}

async function loadProgram({ force = false } = {}) {
  const now = Date.now()
  if (!force && cachedProgram && now - cachedAt < PROGRAM_CACHE_MS) return cachedProgram

  const config = await loadRadioConfig()
  if (!config.is_active) {
    cachedProgram = { active: false, config, tracks: [], slotSeconds: getSlotSeconds() }
    cachedAt = now
    return cachedProgram
  }

  const { data, error } = await supabase
    .from("tracks")
    .select(`
      *,
      artists (
        id,
        name,
        slug,
        avatar_url,
        tip_url
      )
    `)
    .eq("status", "active")
    .limit(MAX_TRACKS)

  if (error) {
    throw new Error(`Supabase tracks fetch failed: ${error.message}`)
  }

  const selectedGenreKeys = new Set((config.selected_genres || []).map(normalizeKey).filter(Boolean))

  const normalized = (data || [])
    .map((track) => {
      const streamUrl = audioUrlFromTrack(track)
      const genre = String(track?.genre || "").trim()
      const artistName = artistNameFromTrack(track)
      const artistKey = normalizeKey(track?.artists?.id || track?.artist_id || artistName || "unknown")

      return {
        id: String(track.id),
        title: String(track.title || track.name || "Bez tytułu"),
        artistName,
        artistKey,
        genre,
        genreKey: normalizeKey(genre),
        streamUrl,
        avatarUrl: artistAvatarFromTrack(track),
      }
    })
    .filter((track) => track.id && track.streamUrl)
    .filter((track) => {
      if (config.mode !== "selected") return true
      if (selectedGenreKeys.size === 0) return false
      return selectedGenreKeys.has(track.genreKey)
    })

  const slotSeconds = getSlotSeconds()
  const nowSeconds = Math.floor(now / 1000)
  const slotIndex = Math.floor(nowSeconds / slotSeconds)
  const roundIndex = normalized.length > 0 ? Math.floor(slotIndex / normalized.length) : 0
  const seed = config.shuffle_enabled ? `coresound-radio:${roundIndex}` : "coresound-radio:ordered"

  const ordered = config.shuffle_enabled
    ? improveArtistMix(deterministicShuffle(normalized, seed))
    : [...normalized].sort((a, b) => a.title.localeCompare(b.title, "pl"))

  cachedProgram = { active: true, config, tracks: ordered, slotSeconds }
  cachedAt = now
  return cachedProgram
}

function getTrackForSlot(program, slotOffset = 0) {
  if (!program?.tracks?.length) return null
  const nowSeconds = Math.floor(Date.now() / 1000)
  const slotIndex = Math.floor(nowSeconds / program.slotSeconds) + slotOffset
  return program.tracks[((slotIndex % program.tracks.length) + program.tracks.length) % program.tracks.length]
}

async function pipeRemoteAudio(track, res, abortController) {
  const response = await fetch(track.streamUrl, {
    signal: abortController.signal,
    headers: {
      "User-Agent": "CoreSoundRadioServer/1.0",
      Accept: "audio/*,*/*;q=0.8",
    },
  })

  if (!response.ok || !response.body) {
    throw new Error(`Remote audio failed ${response.status} for track ${track.id}`)
  }

  const reader = response.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue

      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once("drain", resolve))
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("CoreSound Radio Server OK. Endpoints: /health, /now, /live")
})

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "coresound-radio-server", time: new Date().toISOString() })
})

app.get("/debug", (_req, res) => {
  res.json({ ok: true, ...safeSupabaseInfo() })
})

app.get("/now", async (_req, res) => {
  try {
    const program = await loadProgram()
    const current = getTrackForSlot(program, 0)
    const next = getTrackForSlot(program, 1)

    res.json({
      ok: true,
      active: Boolean(program.active && current),
      station: { id: "coresound-live", name: "CoreSound Radio", slug: "coresound-live" },
      track: current
        ? {
            id: current.id,
            title: current.title,
            artistName: current.artistName,
            genre: current.genre,
            avatar_url: current.avatarUrl || null,
          }
        : null,
      next_track: next
        ? {
            id: next.id,
            title: next.title,
            artistName: next.artistName,
            genre: next.genre,
            avatar_url: next.avatarUrl || null,
          }
        : null,
      pool_size: program.tracks.length,
      slot_seconds: program.slotSeconds,
    })
  } catch (error) {
    console.error("[CoreSound Radio Server] /now error:", safeErrorDetails(error))
    res.status(500).json({ ok: false, error: String(error?.message || error), details: safeErrorDetails(error), supabase: safeSupabaseInfo() })
  }
})

app.get("/refresh", async (_req, res) => {
  try {
    const program = await loadProgram({ force: true })
    res.json({ ok: true, pool_size: program.tracks.length, refreshed_at: new Date().toISOString() })
  } catch (error) {
    console.error("[CoreSound Radio Server] /refresh error:", safeErrorDetails(error))
    res.status(500).json({ ok: false, error: String(error?.message || error), details: safeErrorDetails(error), supabase: safeSupabaseInfo() })
  }
})

app.get("/live", async (req, res) => {
  const abortController = new AbortController()
  let closed = false

  req.on("close", () => {
    closed = true
    abortController.abort()
  })

  res.status(200)
  res.setHeader("Content-Type", "audio/mpeg")
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
  res.setHeader("Pragma", "no-cache")
  res.setHeader("Expires", "0")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders?.()

  console.log("[CoreSound Radio Server] listener connected", new Date().toISOString())

  let slotOffset = 0
  const failedTrackIds = new Set()

  while (!closed) {
    try {
      const program = await loadProgram()

      if (!program.active || !program.tracks.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }

      let track = getTrackForSlot(program, slotOffset)
      let attempts = 0

      while (track && failedTrackIds.has(track.id) && attempts < program.tracks.length) {
        slotOffset += 1
        attempts += 1
        track = getTrackForSlot(program, slotOffset)
      }

      if (!track) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }

      console.log(`[CoreSound Radio Server] streaming: ${track.title} — ${track.artistName}`)
      await pipeRemoteAudio(track, res, abortController)
      failedTrackIds.delete(track.id)
      slotOffset += 1
    } catch (error) {
      if (closed) break

      const message = String(error?.message || error)
      if (message.includes("aborted") || message.includes("AbortError")) break

      console.warn("[CoreSound Radio Server] live stream warning:", safeErrorDetails(error))

      const program = await loadProgram().catch(() => null)
      const current = getTrackForSlot(program, slotOffset)
      if (current?.id) failedTrackIds.add(current.id)
      slotOffset += 1

      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  console.log("[CoreSound Radio Server] listener disconnected", new Date().toISOString())
  try {
    res.end()
  } catch {}
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[CoreSound Radio Server] listening on port ${PORT}`)
})
