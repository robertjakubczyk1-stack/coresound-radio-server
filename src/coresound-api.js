import { config } from './config.js'

function absoluteCoreSoundUrl(pathOrUrl) {
  const value = String(pathOrUrl || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (!value.startsWith('/')) return `${config.coreSoundBaseUrl}/${value}`
  return `${config.coreSoundBaseUrl}${value}`
}

function pickStreamUrl(track) {
  if (!track) return ''

  const original = String(track.original_stream_url || '').trim()
  const proxied = String(track.stream_url || '').trim()

  if (config.useOriginalStreamUrl && original) return original
  if (proxied) return absoluteCoreSoundUrl(proxied)
  if (original) return original
  return ''
}

function normalizeTrack(track) {
  if (!track || !track.id) return null
  const streamUrl = pickStreamUrl(track)
  if (!streamUrl) return null

  return {
    id: String(track.id),
    title: String(track.title || 'Bez tytułu'),
    artistName: String(track.artistName || track.artist_name || 'Nieznany twórca'),
    genre: String(track.genre || ''),
    durationSeconds: Math.max(15, Number(track.duration_seconds || track.durationSeconds || 210) || 210),
    streamUrl,
    originalStreamUrl: String(track.original_stream_url || '').trim(),
    proxiedStreamUrl: track.stream_url ? absoluteCoreSoundUrl(track.stream_url) : '',
  }
}

export async function fetchNowPlaying(reason = 'stream_engine') {
  const url = new URL('/api/radio/now-playing', config.coreSoundBaseUrl)
  url.searchParams.set('platform', 'radio-stream-engine-v2')
  url.searchParams.set('reason', reason)
  url.searchParams.set('ts', String(Date.now()))

  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CoreSound-Radio-Stream-Engine-V2/1.0',
    },
  })

  let data
  try {
    data = await response.json()
  } catch {
    throw new Error(`/api/radio/now-playing returned non-JSON response: ${response.status}`)
  }

  if (!response.ok || !data?.ok) {
    throw new Error(`CoreSound now-playing failed: ${response.status} ${data?.error || data?.message || ''}`)
  }

  const current = normalizeTrack(data.track)
  const queue = Array.isArray(data.queue) ? data.queue.map(normalizeTrack).filter(Boolean) : []
  const nextTrack = normalizeTrack(data.next_track)

  const ordered = []
  if (current) ordered.push(current)
  if (nextTrack && !ordered.some((item) => item.id === nextTrack.id)) ordered.push(nextTrack)
  for (const item of queue) {
    if (!ordered.some((existing) => existing.id === item.id)) ordered.push(item)
  }

  return {
    ok: true,
    active: Boolean(data.active && current),
    raw: data,
    current,
    nextTrack,
    queue,
    ordered,
    positionSeconds: Math.max(0, Number(data.position_seconds || 0) || 0),
    nextChangeAt: data.next_change_at || null,
    nextChangeInSeconds: Math.max(1, Number(data.next_change_in_seconds || 0) || 1),
    poolSize: Number(data.pool_size || 0) || 0,
    config: data.config || null,
  }
}
