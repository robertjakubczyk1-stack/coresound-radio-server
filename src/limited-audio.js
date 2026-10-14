import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function writeLimitedAudio(readable, filePath, maxBytes, signal) {
  let receivedBytes = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length
      if (receivedBytes > maxBytes) {
        callback(new Error('audio_download_too_large'))
      } else {
        callback(null, chunk)
      }
    },
  })
  await pipeline(
    readable,
    limiter,
    createWriteStream(filePath, { flags: 'wx' }),
    { signal },
  )
  return receivedBytes
}
