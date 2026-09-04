import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { draining } from './readiness.js'

// Load backend/.env when present (plain key=value, no shell features).
// process.loadEnvFile exists only on Node >= 20.12 — probe before calling so
// older 20.x fails with the honest env error instead of a TypeError.
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile()
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    logger.warn({ err: String(err) }, 'Could not load .env — relying on real environment variables')
  }
}

const config = loadConfig()
const app = createApp(config)

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    `Cirrus backend listening on http://${config.HOST}:${config.PORT}`,
  )
})

// Startup failures (port already in use, missing capabilities) exit with a
// clean one-liner instead of a stack dump.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error({ port: config.PORT }, `Port ${config.PORT} is already in use — is another instance running?`)
  } else {
    logger.error({ err: String(err) }, 'Server failed to start')
  }
  process.exit(1)
})

// A rejected promise anywhere must never kill the process silently mid-flight.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: String(reason) }, 'Unhandled promise rejection')
})

// Graceful shutdown: stop accepting connections, let in-flight finish.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // Flip readiness first: LBs polling /health must see 503 while this
    // instance drains, not green until the process dies.
    draining.value = true
    logger.info({ signal }, 'Shutting down')
    // Idle keep-alive sockets (OkHttp pools them) would otherwise hold the
    // close open until the hard-exit timer.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
    server.close(() => {
      logger.info('Bye')
      process.exit(0)
    })
    // Hard exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
