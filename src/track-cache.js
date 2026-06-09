import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { log } from './logger.js'

function safeFilePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readFirstBytes(filePath, count = 16) {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(count)
    const result = await handle.read(buffer, 0, count, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function looksLikeHtml(buffer) {
  const text = buffer.toString('utf8').trim().toLowerCase()
  return text.startsWith('<!doctype') || text.startsWith('<html') || text.includes('<head')
}

function looksLikeAudio(buffer) {
  if (buffer.length < 3) return false

  const ascii = buffer.toString('ascii', 0, Math.min(buffer.length, 12))

  if (ascii.startsWith('ID3')) return true
  if (ascii.startsWith('RIFF')) return true
  if (ascii.startsWith('OggS')) return true
  if (ascii.includes('ftyp')) return true

  const b0 = buffer[0]
  const b1 = buffer[1]

  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true

  return false
}

async function validateCachedAudio(filePath) {
  const stats = await fs.stat(filePath)

  if (!stats.isFile()) {
    return { ok: false, reason: 'not_file' }
  }

  if (stats.size < config.minAudioBytes) {
    return { ok: false, reason: 'too_small', size: stats.size }
  }

  if (stats.size > config.maxAudioBytes) {
    return { ok: false, reason: 'too_large', size: stats.size }
  }

  const firstBytes = await readFirstBytes(filePath, 32)

  if (looksLikeHtml(firstBytes)) {
    return { ok: false, reason: 'html_file', size: stats.size }
  }

  if (!looksLikeAudio(firstBytes)) {
    return { ok: false, reason: 'unknown_audio_header', size: stats.size }
  }

  return { ok: true, size: stats.size }
}

export class TrackCache {
  constructor() {
    this.inFlight = new Map()
  }

  async ensureCacheDir() {
    await fs.mkdir(config.cacheDir, { recursive: true })
  }

  cachePathForTrack(track) {
    const id = safeFilePart(track.id)
    return path.join(config.cacheDir, `${id}.audio`)
  }

  tempPathForTrack(track) {
    const id = safeFilePart(track.id)
    return path.join(config.cacheDir, `${id}.${Date.now()}.tmp`)
  }

  async ensureCached(track) {
    await this.ensureCacheDir()

    const finalPath = this.cachePathForTrack(track)

    if (await fileExists(finalPath)) {
      const validation = await validateCachedAudio(finalPath)

      if (validation.ok) {
        return {
          ok: true,
          track: {
            ...track,
            remoteStreamUrl: track.streamUrl,
            streamUrl: finalPath,
            cachedPath: finalPath,
            cachedBytes: validation.size,
          },
          fromCache: true,
        }
      }

      await fs.rm(finalPath, { force: true })
    }

    if (this.inFlight.has(track.id)) {
      return this.inFlight.get(track.id)
    }

    const promise = this.downloadAndValidate(track, finalPath).finally(() => {
      this.inFlight.delete(track.id)
    })

    this.inFlight.set(track.id, promise)
    return promise
  }

  async downloadAndValidate(track, finalPath) {
    const tempPath = this.tempPathForTrack(track)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.downloadTimeoutMs)

    try {
      log.info('Prebuffer downloading track', {
        id: track.id,
        title: track.title,
        artistName: track.artistName,
        url: Boolean(track.streamUrl),
      })

      const response = await fetch(track.streamUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'audio/*,*/*',
          'User-Agent': 'CoreSound-Radio-Buffer-Engine/1.0',
        },
        cache: 'no-store',
      })

      if (!response.ok) {
        return {
          ok: false,
          reason: 'http_error',
          status: response.status,
          track,
        }
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase()

      if (contentType.includes('text/html')) {
        return {
          ok: false,
          reason: 'html_content_type',
          contentType,
          track,
        }
      }

      const contentLengthRaw = response.headers.get('content-length')
      const contentLength = Number.parseInt(contentLengthRaw || '', 10)

      if (Number.isFinite(contentLength) && contentLength > config.maxAudioBytes) {
        return {
          ok: false,
          reason: 'content_too_large',
          contentLength,
          track,
        }
      }

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      if (buffer.length > config.maxAudioBytes) {
        return {
          ok: false,
          reason: 'download_too_large',
          size: buffer.length,
          track,
        }
      }

      await fs.writeFile(tempPath, buffer)

      const validation = await validateCachedAudio(tempPath)

      if (!validation.ok) {
        await fs.rm(tempPath, { force: true })

        return {
          ok: false,
          reason: validation.reason,
          size: validation.size || buffer.length,
          track,
        }
      }

      await fs.rename(tempPath, finalPath)

      log.info('Prebuffer cached track', {
        id: track.id,
        title: track.title,
        artistName: track.artistName,
        bytes: validation.size,
      })

      return {
        ok: true,
        track: {
          ...track,
          remoteStreamUrl: track.streamUrl,
          streamUrl: finalPath,
          cachedPath: finalPath,
          cachedBytes: validation.size,
        },
        fromCache: false,
      }
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {})

      return {
        ok: false,
        reason: err?.name === 'AbortError' ? 'download_timeout' : 'download_failed',
        message: err instanceof Error ? err.message : String(err),
        track,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async prepareQueue(snapshot, neededCount = config.preloadTrackCount) {
    await this.ensureCacheDir()

    const prepared = []
    const rejected = []

    const candidates = Array.isArray(snapshot.ordered) ? snapshot.ordered : []

    for (const track of candidates) {
      if (prepared.length >= neededCount) break
      if (!track?.id || !track?.streamUrl) continue
      if (prepared.some((item) => item.id === track.id)) continue

      const result = await this.ensureCached(track)

      if (result.ok) {
        prepared.push(result.track)
      } else {
        rejected.push({
          id: track.id,
          title: track.title,
          artistName: track.artistName,
          reason: result.reason,
          status: result.status || null,
          message: result.message || null,
        })

        log.warn('Prebuffer rejected track', {
          id: track.id,
          title: track.title,
          artistName: track.artistName,
          reason: result.reason,
          status: result.status || null,
          message: result.message || null,
        })
      }

      if (prepared.length < neededCount) {
        await sleep(100)
      }
    }

    return { prepared, rejected }
  }
}