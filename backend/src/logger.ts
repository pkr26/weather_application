import pino from 'pino'

/**
 * Headers whose values must never reach a log line. Shared by the root
 * logger and the pino-http request serializer configuration (app.ts) so both
 * redact the same credential set. x-api-token is the shared API credential —
 * a log aggregator must never become a token leak.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-goog-api-key"]',
  'req.headers["x-device-secret"]',
  'req.headers["x-api-token"]',
] as const

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: undefined, // drop pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[redacted]',
  },
})
