import { validateConfig, config } from './config.js'

const errors = validateConfig()
if (errors.length) {
  console.error('Invalid configuration:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log('Configuration OK')
console.log({
  coreSoundBaseUrl: config.coreSoundBaseUrl,
  port: config.port,
  ffmpegBin: config.ffmpegBin,
  hlsTimeSeconds: config.hlsTimeSeconds,
  hlsListSize: config.hlsListSize,
})
