import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config } from './config.js'
import { log } from './logger.js'
import { TrackCache } from './track-cache.js'

const FFMPEG_PROGRESS_STALL_MS = 30000

const trackCache = new TrackCache()

function safeName(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').slice(0, 80)
}

async function ensureHlsDir() {
  await fs.mkdir(config.hlsDir, { recursive: true })
}

async function latestSegmentNumber() {
  await ensureHlsDir()

  const entries = await fs.readdir(config.hlsDir).catch(() => [])
  let max = -1

  for (const entry of entries) {
    const match = /^segment_(\d+)\.ts$/.exec(entry)
    if (!match) continue

    const value = Number.parseInt(match[1], 10)
    if (Number.isFinite(value) && value > max) max = value
  }

  return max
}

function parseFfmpegTimeSeconds(text) {
  const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null
  }

  return hours * 3600 + minutes * 60 + seconds
}

async function buildArgs(snapshot) {
  const { prepared, rejected } = await trackCache.prepareQueue(snapshot, config.preloadTrackCount)

  if (prepared.length === 0) {
    throw new Error('No locally cached tracks available for FFmpeg')
  }

  const tracks = prepared
  const current = tracks[0]
  const outputPlaylist = path.join(config.hlsDir, 'playlist.m3u8')
  const segmentPattern = path.join(config.hlsDir, 'segment_%09d.ts')

  // Ważne:
  // Przy lokalnym buforowanym radiu NIE doganiamy zegara CoreSound przez -ss.
  // Każdy utwór z lokalnego cache ma wejść od początku, jak normalne radio.
  const seekSeconds = 0

  const previousLastSegment = await latestSegmentNumber()
  const startNumber = previousLastSegment + 1

  const args = ['-hide_banner', '-y']

  tracks.forEach((track) => {
    args.push('-re')
    args.push('-i', track.streamUrl)
  })

  const concatInputs = tracks.map((_, index) => `[${index}:a:0]`).join('')
  const filter = `${concatInputs}concat=n=${tracks.length}:v=0:a=1[aout]`

  args.push(
    '-filter_complex',
    filter,

    '-map',
    '[aout]',

    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    config.audioBitrate || '128k',
    '-ar',
    '44100',
    '-ac',
    '2',

    '-f',
    'hls',
    '-hls_time',
    String(config.hlsTimeSeconds || 6),

    '-hls_list_size',
    String(config.hlsListSize || 36),

    '-hls_flags',
    'append_list+delete_segments+program_date_time+independent_segments+omit_endlist+temp_file',

    '-hls_delete_threshold',
    String(config.hlsDeleteThreshold || 24),

    '-hls_allow_cache',
    '0',

    '-hls_segment_type',
    'mpegts',

    '-start_number',
    String(startNumber),

    '-hls_segment_filename',
    segmentPattern,

    outputPlaylist,
  )

  return {
    args,
    tracks,
    rejected,
    current,
    outputPlaylist,
    segmentPattern,
    seekSeconds,
    startNumber,
    previousLastSegment,
  }
}

export class FfmpegRunner {
  constructor(options = {}) {
    this.process = null
    this.startedAtMs = 0
    this.currentTrackId = null
    this.lastExit = null
    this.snapshot = null
    this.lastStartError = null
    this.onExit = typeof options.onExit === 'function' ? options.onExit : null

    this.manualStop = false
    this.progressTimer = null
    this.lastMediaTimeSeconds = 0
    this.lastProgressAtMs = Date.now()
    this.lastProgressText = ''
    this.stallRestarting = false
    this.lastRejectedTracks = []
  }

  isRunning() {
    return Boolean(this.process && !this.process.killed)
  }

  clearProgressWatchdog() {
    if (this.progressTimer) clearInterval(this.progressTimer)
    this.progressTimer = null
  }

  startProgressWatchdog(child) {
    this.clearProgressWatchdog()

    this.lastMediaTimeSeconds = 0
    this.lastProgressAtMs = Date.now()
    this.lastProgressText = ''
    this.stallRestarting = false

    this.progressTimer = setInterval(() => {
      if (!this.process || this.process !== child || child.killed) return
      if (!this.lastProgressAtMs) return

      const silentForMs = Date.now() - this.lastProgressAtMs

      if (silentForMs < FFMPEG_PROGRESS_STALL_MS) return
      if (this.stallRestarting) return

      this.stallRestarting = true
      this.manualStop = false

      log.error('FFmpeg progress stalled. Killing process so engine can restart live stream.', {
        pid: child.pid,
        silentForMs,
        lastMediaTimeSeconds: this.lastMediaTimeSeconds,
        lastProgressText: this.lastProgressText,
        currentTrackId: this.currentTrackId,
      })

      try {
        child.kill('SIGKILL')
      } catch (err) {
        log.error('Failed to kill stalled FFmpeg', {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }, 5000)
  }

  handleProgressText(text) {
    const mediaTimeSeconds = parseFfmpegTimeSeconds(text)
    if (mediaTimeSeconds === null) return

    this.lastProgressText = text

    if (mediaTimeSeconds > this.lastMediaTimeSeconds + 0.2) {
      this.lastMediaTimeSeconds = mediaTimeSeconds
      this.lastProgressAtMs = Date.now()
    }

    if (!this.lastProgressAtMs) {
      this.lastMediaTimeSeconds = mediaTimeSeconds
      this.lastProgressAtMs = Date.now()
    }
  }

  status() {
    return {
      running: this.isRunning(),
      pid: this.process?.pid || null,
      startedAt: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
      currentTrackId: this.currentTrackId,
      lastExit: this.lastExit,
      lastStartError: this.lastStartError,
      rejectedTracks: this.lastRejectedTracks,
      progress: {
        lastMediaTimeSeconds: this.lastMediaTimeSeconds,
        lastProgressAt: this.lastProgressAtMs ? new Date(this.lastProgressAtMs).toISOString() : null,
        stallTimeoutMs: FFMPEG_PROGRESS_STALL_MS,
        lastProgressText: this.lastProgressText,
      },
      snapshot: this.snapshot
        ? {
            active: this.snapshot.active,
            current: this.snapshot.current
              ? {
                  id: this.snapshot.current.id,
                  title: this.snapshot.current.title,
                  artistName: this.snapshot.current.artistName,
                  durationSeconds: this.snapshot.current.durationSeconds,
                  streamUrl: Boolean(this.snapshot.current.streamUrl),
                }
              : null,
            positionSeconds: this.snapshot.positionSeconds,
            queueSize: this.snapshot.ordered?.length || 0,
          }
        : null,
    }
  }

  async start(snapshot, reason = 'start') {
    if (!snapshot?.active || !snapshot.current) {
      await this.stop('inactive')
      return
    }

    if (this.isRunning()) {
      this.snapshot = snapshot
      return
    }

    await ensureHlsDir()

    const {
      args,
      tracks,
      rejected,
      current,
      outputPlaylist,
      segmentPattern,
      seekSeconds,
      startNumber,
      previousLastSegment,
    } = await buildArgs(snapshot)

    this.currentTrackId = current.id
    this.startedAtMs = Date.now()
    this.snapshot = snapshot
    this.lastStartError = null
    this.manualStop = false
    this.lastRejectedTracks = rejected

    log.info('Starting FFmpeg HLS stream', {
      reason,
      mode: 'local-cache-prebuffer-hls-no-seek',
      current: `${safeName(current.artistName)} - ${safeName(current.title)}`,
      positionSeconds: snapshot.positionSeconds,
      seekSeconds,
      durationSeconds: current.durationSeconds,
      queueSize: tracks.length,
      rejectedCount: rejected.length,
      hlsListSize: config.hlsListSize || 36,
      hlsDeleteThreshold: config.hlsDeleteThreshold || 24,
      previousLastSegment,
      startNumber,
      progressStallMs: FFMPEG_PROGRESS_STALL_MS,
      hlsFlags: 'append_list+delete_segments+program_date_time+independent_segments+omit_endlist+temp_file',
      inputs: tracks.map((track) => ({
        title: `${safeName(track.artistName)} - ${safeName(track.title)}`,
        cachedPath: track.cachedPath,
        cachedBytes: track.cachedBytes,
      })),
      hlsDir: config.hlsDir,
      outputPlaylist,
      segmentPattern,
    })

    const child = spawn(config.ffmpegBin, args, {
      cwd: config.rootDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.process = child
    this.startProgressWatchdog(child)

    child.stdout.on('data', (data) => {
      const text = String(data).trim()
      if (text) log.info(`ffmpeg stdout: ${text}`)
    })

    child.stderr.on('data', (data) => {
      const text = String(data).trim()
      if (!text) return

      this.handleProgressText(text)
      log.warn(`ffmpeg: ${text}`)
    })

    child.on('error', (err) => {
      this.lastStartError = {
        message: err.message,
        code: err.code || null,
        at: new Date().toISOString(),
      }

      log.error('FFmpeg process error', this.lastStartError)

      if (this.process === child) {
        this.process = null
      }

      this.clearProgressWatchdog()

      if (!this.manualStop && this.onExit) {
        this.onExit({
          code: null,
          signal: 'error',
          at: new Date().toISOString(),
          reason: 'ffmpeg-error',
          error: this.lastStartError,
        })
      }
    })

    child.on('exit', (code, signal) => {
      this.lastExit = {
        code,
        signal,
        at: new Date().toISOString(),
        manualStop: this.manualStop,
        stalled: this.stallRestarting,
      }

      log.warn('FFmpeg exited', this.lastExit)

      if (this.process === child) {
        this.process = null
      }

      this.clearProgressWatchdog()

      const shouldRestart = !this.manualStop && this.onExit

      if (shouldRestart) {
        this.onExit({
          ...this.lastExit,
          reason: this.stallRestarting ? 'ffmpeg-progress-stalled' : 'ffmpeg-ended',
        })
      }
    })
  }

  async stop(reason = 'manual') {
    const child = this.process
    if (!child) return

    log.info('Stopping FFmpeg', { reason, pid: child.pid })

    this.manualStop = true
    this.process = null
    this.clearProgressWatchdog()

    try {
      child.kill('SIGTERM')
    } catch {
      return
    }

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }

        resolve()
      }, 2500)

      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}