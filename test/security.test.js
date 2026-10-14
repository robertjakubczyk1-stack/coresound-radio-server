import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBlockedAddress, validateAudioUrl, resolvePublicAudioTarget } from '../src/safe-audio-request.js'
import { writeLimitedAudio } from '../src/limited-audio.js'

test('blocks local, metadata, documentation and IPv6 private addresses', () => {
  for (const value of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '172.16.2.4', '192.168.1.9', '198.18.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isBlockedAddress(value), true, value)
  }
  assert.equal(isBlockedAddress('1.1.1.1'), false)
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false)
})

test('rejects local addresses, credentials and unsupported schemes', () => {
  for (const url of [
    'http://localhost/media.mp3', 'https://127.0.0.1/mp3',
    'http://169.254.169.254/latest/meta-data',
    'https://user:password@cdn.example/audio.mp3',
    'file:///etc/passwd', 'http://music.local/track.mp3',
  ]) assert.throws(() => validateAudioUrl(url), undefined, url)
})

test('pins safe DNS address and rejects mixed public/private answers', async () => {
  const allowed = await resolvePublicAudioTarget('https://audio.example/song.mp3', async () => [{ address: '1.1.1.1', family: 4 }])
  assert.equal(allowed.address, '1.1.1.1')
  assert.equal(allowed.hostname, 'audio.example')
  await assert.rejects(resolvePublicAudioTarget('https://audio.example/song.mp3', async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]), /unsafe_audio_dns/)
  await assert.rejects(resolvePublicAudioTarget('https://audio.example/song.mp3', async () => []), /unsafe_audio_dns/)
})

test('writes audio bytes directly to disk within the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coresound-test-'))
  try {
    const target = join(dir, 'small.audio')
    const size = await writeLimitedAudio(Readable.from([Buffer.from('ID3'), Buffer.alloc(20)]), target, 64)
    assert.equal(size, 23)
    assert.equal((await readFile(target)).length, 23)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('aborts streaming when server exceeds byte cap without Content-Length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coresound-test-'))
  try {
    const target = join(dir, 'huge.audio')
    await assert.rejects(
      writeLimitedAudio(Readable.from([Buffer.alloc(50), Buffer.alloc(50)]), target, 60),
      /audio_download_too_large/,
    )
    const data = await readFile(target)
    assert.ok(data.length <= 60)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
