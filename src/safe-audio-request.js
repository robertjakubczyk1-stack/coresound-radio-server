import { lookup } from 'node:dns/promises'
import { isIP, BlockList } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const blocked = new BlockList()
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(subnet, prefix, 'ipv4')

for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96],
  ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8],
]) blocked.addSubnet(subnet, prefix, 'ipv6')

export function isBlockedAddress(address) {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) {
    // IPv6 addresses outside 2000::/3 are not global unicast.
    const firstHextet = Number.parseInt(address.split(':')[0] || '0', 16)
    if (!(firstHextet >= 0x2000 && firstHextet <= 0x3fff)) return true
    return blocked.check(address, 'ipv6')
  }
  return true
}

export function validateAudioUrl(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error('unsafe_audio_url')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('unsafe_audio_url')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname || hostname === 'localhost' ||
      hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) {
    throw new Error('unsafe_audio_host')
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) throw new Error('unsafe_audio_ip')
  return { url, hostname }
}

export async function resolvePublicAudioTarget(input, resolver = lookup) {
  const { url, hostname } = validateAudioUrl(input)
  const literalFamily = isIP(hostname)
  if (literalFamily) return { url, hostname, address: hostname, family: literalFamily }

  let answers
  try {
    answers = await resolver(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('audio_dns_failed')
  }
  if (!Array.isArray(answers) || answers.length === 0 ||
      answers.some(({ address, family }) => ![4, 6].includes(family) || isBlockedAddress(address))) {
    throw new Error('unsafe_audio_dns')
  }
  return { url, hostname, address: answers[0].address, family: answers[0].family }
}

function pinnedGet(target, signal) {
  return new Promise((resolve, reject) => {
    const client = target.url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = client({
      protocol: target.url.protocol,
      hostname: target.address,
      family: target.family,
      port: target.url.port || undefined,
      path: target.url.pathname + target.url.search,
      method: 'GET',
      servername: target.hostname,
      headers: {
        Host: target.url.host,
        Accept: 'audio/*,*/*',
        'User-Agent': 'CoreSound-Radio-Buffer-Engine/1.0',
      },
      signal,
    }, resolve)
    request.once('error', reject)
    request.end()
  })
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

export async function openSafeAudioStream(input, options = {}) {
  const { signal, resolver = lookup, maxRedirects = 5 } = options
  let current = input
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // A validated DNS address is passed directly to the TCP connection. Never
    // resolve the hostname again after validation (DNS rebinding).
    const target = await resolvePublicAudioTarget(current, resolver)
    const response = await pinnedGet(target, signal)
    if (!REDIRECT_CODES.has(response.statusCode)) return response

    const location = response.headers.location
    response.destroy()
    if (!location || hop === maxRedirects) throw new Error('audio_redirect_limit')
    current = new URL(location, target.url).toString()
  }
  throw new Error('audio_redirect_limit')
}
