function line(level, message, data) {
  const time = new Date().toISOString()
  if (data === undefined) {
    console.log(`[${time}] [${level}] ${message}`)
    return
  }
  console.log(`[${time}] [${level}] ${message}`, data)
}

export const log = {
  info: (message, data) => line('INFO', message, data),
  warn: (message, data) => line('WARN', message, data),
  error: (message, data) => line('ERROR', message, data),
}
