import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

function cleanBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '')
  if (!raw) return ''
  return raw
}

function intFromEnv(name, fallback, min = 0) {
  const value = Number.parseInt(process.env[name] || '', 10)
  if (!Number.isFinite(value) || value < min) return fallback
  return value
}

export const config = {
  port: intFromEnv('PORT', 8787, 1),
  coreSoundBaseUrl: cleanBaseUrl(process.env.CORESOUND_BASE_URL),
  ffmpegBin: String(process.env.FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg',

  hlsTimeSeconds: intFromEnv('HLS_TIME_SECONDS', 6, 2),
  hlsListSize: intFromEnv('HLS_LIST_SIZE', 36, 6),
  hlsDeleteThreshold: intFromEnv('HLS_DELETE_THRESHOLD', 24, 6),

  audioBitrate: String(process.env.AUDIO_BITRATE || '128k').trim() || '128k',

  pollIntervalMs: intFromEnv('POLL_INTERVAL_MS', 30000, 5000),
  minRestartIntervalMs: intFromEnv('MIN_RESTART_INTERVAL_MS', 90000, 30000),

  useOriginalStreamUrl: String(process.env.USE_ORIGINAL_STREAM_URL || '1') !== '0',

  preloadTrackCount: intFromEnv('PRELOAD_TRACK_COUNT', 6, 3),
  downloadTimeoutMs: intFromEnv('DOWNLOAD_TIMEOUT_MS', 90000, 15000),
  minAudioBytes: intFromEnv('MIN_AUDIO_BYTES', 150000, 10000),
  maxAudioBytes: intFromEnv('MAX_AUDIO_BYTES', 120000000, 1000000),

  rootDir,
  hlsDir: path.join(rootDir, 'hls'),
  cacheDir: path.join(rootDir, 'cache'),
}

export function validateConfig() {
  const errors = []

  if (!config.coreSoundBaseUrl) errors.push('Missing CORESOUND_BASE_URL')

  if (!/^https?:\/\//i.test(config.coreSoundBaseUrl)) {
    errors.push('CORESOUND_BASE_URL must start with http:// or https://')
  }

  return errors
}