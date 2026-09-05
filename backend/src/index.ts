// First import, before anything that reads process.env at module scope (the
// pino logger's LOG_LEVEL): ESM evaluates this chain depth-first, so './env.js'
// must precede './app.js' for .env values to be visible to every module.
import './env.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { draining } from './readiness.js'

const config = loadConfig()
const app = createApp(config)

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    `Cirrus backend listening on http://${config.HOST}:${config.PORT}`,
  )
})

// Explicit request-lifecycle timeouts instead of Node's generous defaults:
// headers must arrive within 10 s (slowloris sockets hold no worker for
// long), the whole request gets 35 s — above the 20 s upstream deadline so
// the deadline, not the server, produces the client's error — and idle
// keep-alive sockets (OkHttp pools them) are reaped at 5 s so a draining
// instance can actually close.
server.headersTimeout = 10_000
server.requestTimeout = 35_000
server.keepAliveTimeout = 5_000

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
