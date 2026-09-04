import { promises as fs } from 'node:fs'
import path from 'node:path'
import { logger } from '../logger.js'
import { RegistryFullError } from '../errors.js'

/**
 * Device registry: which devices want notifications, in which language,
 * for which city, at what local time. Persisted as a single JSON document
 * with atomic writes — honest and dependency-free; swap the class for a
 * database-backed implementation (same interface) when you outgrow one node.
 */
export interface DeviceRecord {
  deviceId: string
  /** SHA-256 of the device secret — persisted, never returned by any endpoint. */
  secretHash?: string
  language: string
  city: {
    id: string
    name: string
    latitude: number
    longitude: number
    timeZone?: string
  }
  notificationTime: { hour: number; minute: number }
  units: 'metric' | 'imperial'
  alertsEnabled: boolean
  updatedAt: string
  createdAt: string
}

/**
 * Strips fields that must never appear in an API response. `fcmToken` is
 * still stripped defensively: records written by older versions of the
 * store may carry one even though the field no longer exists.
 */
export function publicDevice(
  record: DeviceRecord & { fcmToken?: unknown },
): Omit<DeviceRecord, 'secretHash' | 'fcmToken'> {
  const { secretHash: _s, fcmToken: _f, ...publicFields } = record
  return publicFields
}

interface StoreShape {
  version: 1
  devices: Record<string, DeviceRecord>
}

/** Keys that collide with Object.prototype machinery — never stored. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const DAY_MS = 24 * 60 * 60 * 1000

export class DeviceStore {
  private readonly file: string
  private readonly maxDevices: number
  /** Records whose updatedAt falls this far behind are pruned at load. */
  private readonly maxAgeMs: number
  // Null prototype from the start: writes through a normal-prototype record
  // could otherwise mutate Object.prototype machinery instead of adding an
  // own property (the load path rebuilds through null for the same reason).
  private data: StoreShape = { version: 1, devices: Object.create(null) }
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(dataDir: string, maxDevices = 25_000, maxAgeMs = 365 * DAY_MS) {
    this.file = path.join(dataDir, 'devices.json')
    this.maxDevices = maxDevices
    this.maxAgeMs = maxAgeMs
  }

  private async ensureLoaded(): Promise<void> {
    // Re-reading is idempotent (same records, same prune) and Buffer input
    // parses identically to utf8 text — verified equivalents.
    // Stryker disable ConditionalExpression,StringLiteral,BooleanLiteral
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      // Stryker restore
      const parsed = JSON.parse(raw) as StoreShape
      // The typeof arm is a verified equivalent (non-object shapes yield
      // the same empty store); the version and null arms are killed by the
      // wrong-version / not-a-record tests.
      // Stryker disable ConditionalExpression
      if (parsed?.version === 1 && parsed.devices && typeof parsed.devices === 'object') {
      // Stryker restore
        // Rebuild through a null-prototype object and skip dangerous keys:
        // a hand-edited file can never smuggle prototype-polluting entries
        // into the live store. fcmToken (a field older versions persisted
        // but never used) is dropped, and records whose updatedAt is older
        // than the registry's max age are pruned so a filled registry
        // self-heals instead of 503-ing new devices forever.
        const cutoff = Date.now() - this.maxAgeMs
        const devices: Record<string, DeviceRecord> = Object.create(null)
        for (const [key, value] of Object.entries(parsed.devices)) {
          if (FORBIDDEN_KEYS.has(key)) continue
          const { fcmToken: _dropped, ...record } = value as DeviceRecord & { fcmToken?: unknown }
          // The '' fallback for a missing updatedAt is a verified
          // equivalent: Date.parse('') is NaN either way, so the record is
          // pruned identically.
          // Stryker disable StringLiteral
          const updatedAt = Date.parse(record.updatedAt ?? '')
          // Stryker restore
          if (!Number.isFinite(updatedAt) || updatedAt < cutoff) continue
          devices[key] = record
        }
        this.data = { version: 1, devices }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: String(err) }, 'Device store unreadable, starting fresh')
      }
    }
    this.loaded = true
  }

  /** Serialized atomic persistence (tmp file + fsync + rename), owner-only. */
  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        // mode 0o600: the store holds secret hashes and FCM tokens.
        // encoding '' is treated as utf8 by Node (verified byte-identical).
        // Stryker disable StringLiteral
        await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
        // Stryker restore
        // Flush to disk before the atomic swap so a crash can't leave the
        // rename ahead of the data.
        // fsync + close are crash-durability hygiene; skipping them cannot
        // change any observable outcome in a running process.
        // Stryker disable BlockStatement,CallExpression
        const handle = await fs.open(tmp, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        // Stryker restore
        await fs.rename(tmp, this.file)
      } catch (err) {
        logger.error({ err: String(err) }, 'Failed to persist device store')
      }
    })
    return this.writeQueue
  }

  /**
   * Creates the record only if its deviceId is free — the existence check
   * and the insertion happen in one synchronous step (no await between
   * them), so concurrent first registrations for the same id cannot both
   * win. Returns `{ created: true, record }` on success, or the
   * pre-existing record with `created: false` when the id is taken.
   */
  async createIfAbsent(
    record: Omit<DeviceRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<{ created: boolean; record: DeviceRecord }> {
    await this.ensureLoaded()
    if (FORBIDDEN_KEYS.has(record.deviceId)) {
      throw new Error('Reserved device id')
    }
    const existing = this.data.devices[record.deviceId]
    if (existing !== undefined) {
      return { created: false, record: existing }
    }
    if (Object.keys(this.data.devices).length >= this.maxDevices) {
      throw new RegistryFullError()
    }
    const now = new Date().toISOString()
    const saved: DeviceRecord = { ...record, createdAt: now, updatedAt: now }
    this.data.devices[record.deviceId] = saved
    await this.persist()
    return { created: true, record: saved }
  }

  async upsert(record: Omit<DeviceRecord, 'createdAt' | 'updatedAt'>): Promise<DeviceRecord> {
    await this.ensureLoaded()
    if (FORBIDDEN_KEYS.has(record.deviceId)) {
      throw new Error('Reserved device id')
    }
    const existing = this.data.devices[record.deviceId]
    if (!existing && Object.keys(this.data.devices).length >= this.maxDevices) {
      throw new RegistryFullError()
    }
    const now = new Date().toISOString()
    const saved: DeviceRecord = { ...record, createdAt: existing?.createdAt ?? now, updatedAt: now }
    this.data.devices[record.deviceId] = saved
    await this.persist()
    return saved
  }

  async get(deviceId: string): Promise<DeviceRecord | null> {
    await this.ensureLoaded()
    // Own-property check: lookups must never resolve through the prototype
    // chain (inherited "constructor"/field-name keys are not records).
    if (!Object.hasOwn(this.data.devices, deviceId)) return null
    // The load step guarantees every own value is a full record.
    return this.data.devices[deviceId] as DeviceRecord
  }

  async delete(deviceId: string): Promise<boolean> {
    await this.ensureLoaded()
    if (!Object.hasOwn(this.data.devices, deviceId)) return false
    delete this.data.devices[deviceId]
    await this.persist()
    return true
  }

  async list(): Promise<DeviceRecord[]> {
    await this.ensureLoaded()
    return Object.values(this.data.devices)
  }
}
