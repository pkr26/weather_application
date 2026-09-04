import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

/**
 * Optional shared-token gate for deployments where the backend is publicly
 * reachable and must not proxy the metered weather API for strangers.
 * Enabled by setting API_TOKEN; compares SHA-256 digests with
 * timingSafeEqual (same shape as device-secret verification, so the token's
 * length is not an oracle).
 */

export const API_TOKEN_HEADER = 'x-api-token'

export function verifyApiToken(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false
  // '' is treated as utf8 by Node (verified identical digests for both sides).
  // Stryker disable StringLiteral
  // Both digests are exactly 32 bytes — timingSafeEqual can never throw here.
  return timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  )
  // Stryker restore
}

export function requireApiToken(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (verifyApiToken(req.header(API_TOKEN_HEADER), token)) {
      next()
      return
    }
    res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid API token.' })
  }
}
