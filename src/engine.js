import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { fetchNowPlaying } from './coresound-api.js'
import { FfmpegRunner } from './ffmpeg-runner.js'
import { log } from './logger.js'

export class RadioStreamEngine {
  constructor() {
    this.timer = null
    this.lastSnapshot = null
    this.lastError = null
    this.started = false
    this.activeSnapshot = null
    this.starting = false

    this.runner = new FfmpegRunner({
      onExit: (exitInfo) => {
        if (!this.started) return

        log.warn('FFmpeg ended or stalled. Engine will start next live package.', exitInfo)

        setTimeout(() => {
          this.tick('ffmpeg-restart').catch((err) => {
            this.lastError = {
              message: err.message,
              at: new Date().toISOString(),
            }
            log.error('Engine restart after FFmpeg exit failed', this.lastError)
          })
        }, 500)
      },
    })
  }

  async start() {
    if (this.started) return

    this.started = true

    await fs.mkdir(config.hlsDir, { recursive: true })
    await this.tick('startup')

    this.timer = setInterval(() => {
      this.tick('poll').catch((err) => {
        this.lastError = {
          message: err.message,
          at: new Date().toISOString(),
        }

        log.error('Engine poll failed', this.lastError)
      })
    }, config.pollIntervalMs)
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)

    this.timer = null
    this.started = false
    this.activeSnapshot = null
    this.starting = false

    await this.runner.stop('engine-stop')
  }

  async tick(reason = 'poll') {
    const snapshot = await fetchNowPlaying(reason)

    this.lastSnapshot = snapshot
    this.lastError = null

    if (!snapshot.active || !snapshot.current) {
      this.activeSnapshot = null
      await this.runner.stop('radio-inactive')
      return
    }

    if (this.runner.isRunning()) {
      if (snapshot.current?.id !== this.runner.currentTrackId) {
        const runnerStatus = this.runner.status()

        log.warn('Poll track change ignored because FFmpeg is still running', {
          reason,
          liveTrackId: this.runner.currentTrackId,
          liveStartedAt: runnerStatus.startedAt,
          polledTrackId: snapshot.current?.id,
          polledTitle: snapshot.current?.title,
          polledArtist: snapshot.current?.artistName,
          polledPositionSeconds: snapshot.positionSeconds,
          polledNextChangeInSeconds: snapshot.nextChangeInSeconds,
        })
      }

      return
    }

    if (this.starting) return

    this.starting = true

    try {
      this.activeSnapshot = snapshot
      await this.runner.start(snapshot, reason)
    } finally {
      this.starting = false
    }
  }

  async hasPlaylist() {
    try {
      await fs.access(path.join(config.hlsDir, 'playlist.m3u8'))
      return true
    } catch {
      return false
    }
  }

  status() {
    return {
      ok: true,
      engine: 'coresound-radio-stream-engine-v2-endless-hls-progress-watchdog',
      started: this.started,
      hls: {
        playlist: '/playlist.m3u8',
        files: '/hls/',
        hlsTimeSeconds: config.hlsTimeSeconds,
        hlsListSize: config.hlsListSize,
        hlsDeleteThreshold: config.hlsDeleteThreshold,
        mode: 'endless-hls-append',
        watchdog: 'ffmpeg-progress-time',
      },
      coreSound: {
        baseUrl: config.coreSoundBaseUrl,
        source: '/api/radio/now-playing',
      },
      runner: this.runner.status(),
      activeSnapshot: this.activeSnapshot
        ? {
            current: this.activeSnapshot.current
              ? {
                  id: this.activeSnapshot.current.id,
                  title: this.activeSnapshot.current.title,
                  artistName: this.activeSnapshot.current.artistName,
                  durationSeconds: this.activeSnapshot.current.durationSeconds,
                }
              : null,
          }
        : null,
      lastError: this.lastError,
      lastSnapshot: this.lastSnapshot
        ? {
            active: this.lastSnapshot.active,
            current: this.lastSnapshot.current
              ? {
                  id: this.lastSnapshot.current.id,
                  title: this.lastSnapshot.current.title,
                  artistName: this.lastSnapshot.current.artistName,
                }
              : null,
            nextTrack: this.lastSnapshot.nextTrack
              ? {
                  id: this.lastSnapshot.nextTrack.id,
                  title: this.lastSnapshot.nextTrack.title,
                  artistName: this.lastSnapshot.nextTrack.artistName,
                }
              : null,
            positionSeconds: this.lastSnapshot.positionSeconds,
            nextChangeInSeconds: this.lastSnapshot.nextChangeInSeconds,
            queueSize: this.lastSnapshot.ordered.length,
          }
        : null,
    }
  }
}