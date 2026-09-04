import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { DeviceStore } from '../store/deviceStore.js'
import { unauthorized } from '../errors.js'

/**
 * Bearer-style secret for the device registry:
 * - issued once, in the 201 response of POST /devices
 * - stored server-side only as a SHA-256 hash
 * - required (X-Device-Secret header) to read or delete a device record,
 *   so device IDs alone can never enumerate or tamper with registrations.
 */

export const DEVICE_SECRET_HEADER = 'x-device-secret'
const SECRET_BYTES = 32

/** Burned on the unknown-device path so timing can't reveal device existence. */
// Stryker disable StringLiteral: the pad's exact content is arbitrary by design — only its shape (a fixed SHA-256 digest / 32-byte hex) matters, and the encoding mutates to identical output (verified: update(s, '') ≡ update(s, 'utf8'))
const DUMMY_HASH = hashDeviceSecret(`cirrus-timing-pad-${randomBytes(32).toString('hex')}`)
const DUMMY_PRESENTED = randomBytes(SECRET_BYTES).toString('hex')
// Stryker restore StringLiteral

export function generateDeviceSecret(): string {
  return randomBytes(SECRET_BYTES).toString('hex')
}

// Stryker disable StringLiteral: '' is treated as utf8 by Node (verified identical digests); 'sha256'/'hex' changes are pinned by the exact-digest test
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
// Stryker restore StringLiteral

/**
 * Constant-time comparison of a presented secret against a stored hash.
 * The dummy comparison keeps the timing profile identical when the input
 * length is wrong, so length itself is not an oracle.
 */
export function verifyDeviceSecret(presented: string | undefined, storedHash: string | undefined): boolean {
  if (!presented || !storedHash) return false
  const presentedHash = Buffer.from(hashDeviceSecret(presented), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (presentedHash.length !== stored.length) {
    // Burn a comparison so the length-mismatch path takes the same time as
    // the full compare; removing it cannot change any observable outcome.
    // Stryker disable CallExpression: timing-hygiene only — verified equivalent
    timingSafeEqual(presentedHash, presentedHash)
    // Stryker restore CallExpression
    return false
  }
  return timingSafeEqual(presentedHash, stored)
}

export function requireDeviceSecret(store: DeviceStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Express always provides the declared :deviceId route param.
    const deviceId = String(req.params.deviceId)
    void store
      .get(deviceId)
      .then((record) => {
        // Always hash-and-compare, even for unknown devices or a missing
        // header: the same work happens on every path, so response timing
        // never reveals whether a device ID exists.
        const presented = req.header(DEVICE_SECRET_HEADER) ?? DUMMY_PRESENTED
        const ok = verifyDeviceSecret(presented, record?.secretHash ?? DUMMY_HASH)
        if (record && ok) {
          res.locals.device = record
          next()
          return
        }
        // Same response whether the device or the secret is wrong.
        res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid device secret.' })
      })
      .catch(next)
  }
}
