import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DeviceStore, publicDevice } from '../src/store/deviceStore.js'
import { RegistryFullError } from '../src/errors.js'
import { logger } from '../src/logger.js'

process.env.LOG_LEVEL = 'silent'

const root = mkdtempSync(path.join(tmpdir(), 'cirrus-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const dir = (name: string) => path.join(root, name)

function sampleRecord(deviceId = 'device-12345678') {
  return {
    deviceId,
    language: 'en',
    city: { id: 'c', name: 'Testville', latitude: 1, longitude: 2 },
    notificationTime: { hour: 8, minute: 0 },
    units: 'metric' as const,
    alertsEnabled: true,
  }
}

describe('DeviceStore', () => {
  it('round-trips records through disk', async () => {
    const dataDir = dir('roundtrip')
    const first = new DeviceStore(dataDir)
    const saved = await first.upsert({ ...sampleRecord(), secretHash: 'abc' })

    // A fresh instance (e.g. after restart) reads the same data.
    const second = new DeviceStore(dataDir)
    const loaded = await second.get('device-12345678')
    expect(loaded).toEqual(saved)
  })

  it('preserves createdAt across updates', async () => {
    const store = new DeviceStore(dir('timestamps'))
    const a = await store.upsert(sampleRecord())
    const b = await store.upsert(sampleRecord())
    expect(b.createdAt).toBe(a.createdAt)
    expect(b.updatedAt >= a.updatedAt).toBe(true)
  })

  it('returns null for unknown devices and false for unknown deletes', async () => {
    const store = new DeviceStore(dir('unknowns'))
    expect(await store.get('ghost-00000000')).toBeNull()
    expect(await store.delete('ghost-00000000')).toBe(false)
  })

  it('deletes a registered device', async () => {
    const store = new DeviceStore(dir('delete'))
    await store.upsert(sampleRecord())
    expect(await store.delete('device-12345678')).toBe(true)
    expect(await store.get('device-12345678')).toBeNull()
  })

  it('recovers from a corrupted store file by starting fresh', async () => {
    const dataDir = dir('corrupt')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord())
    writeFileSync(path.join(dataDir, 'devices.json'), '{not valid json')

    const reopened = new DeviceStore(dataDir)
    expect(await reopened.get('device-12345678')).toBeNull()
    // And the store stays writable afterwards.
    const saved = await reopened.upsert(sampleRecord())
    expect(saved.deviceId).toBe('device-12345678')
  })

  it('quarantines a store file with an unexpected version instead of overwriting it', async () => {
    const dataDir = dir('version')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord())
    const file = path.join(dataDir, 'devices.json')
    writeFileSync(file, JSON.stringify({ version: 99, devices: { junk: true } }))

    const reopened = new DeviceStore(dataDir)
    expect(await reopened.get('device-12345678')).toBeNull()
    // The foreign-format file is renamed aside, not destroyed: a future
    // store version's data must survive for migration instead of being
    // silently overwritten by the next persist.
    const files = readdirSync(dataDir)
    expect(files.includes('devices.json')).toBe(false)
    expect(files.some((f) => f.startsWith('devices.json.wrongversion-'))).toBe(true)
    // And the store stays writable afterwards (fresh file on next persist).
    await reopened.upsert(sampleRecord('device-version002'))
    expect(readFileSync(path.join(dataDir, 'devices.json'), 'utf8')).toContain('device-version002')
  })

  it('starts fresh even when the quarantine rename itself fails', async () => {
    // EXDEV/EIO on the rename-aside must not break the fresh-start path —
    // the catch is by design; the store still loads empty and stays writable.
    const dataDir = dir('version-rename-fail')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-version-x'))
    const file = path.join(dataDir, 'devices.json')
    writeFileSync(file, JSON.stringify({ version: 99, devices: {} }))
    const renameSpy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('EXDEV'))
    try {
      const reopened = new DeviceStore(dataDir)
      await reopened.upsert(sampleRecord('device-version-y'))
      expect(await reopened.get('device-version-y')).toBeTruthy()
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('persists the secret hash but publicDevice strips it', async () => {
    const dataDir = dir('secrets')
    const store = new DeviceStore(dataDir)
    await store.upsert({ ...sampleRecord('device-withsec1'), secretHash: 'hash123' })

    const raw = JSON.parse(readFileSync(path.join(dataDir, 'devices.json'), 'utf8'))
    expect(raw.devices['device-withsec1'].secretHash).toBe('hash123')

    const record = await store.get('device-withsec1')
    expect(record?.secretHash).toBe('hash123')
    expect(publicDevice(record!)).not.toHaveProperty('secretHash')
    expect(publicDevice(record!)).not.toHaveProperty('fcmToken')
    expect(publicDevice(record!).deviceId).toBe('device-withsec1')
  })

  it('writes the store human-readable and pretty-printed', async () => {
    const dataDir = dir('pretty')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-pretty0001'))
    const text = readFileSync(path.join(dataDir, 'devices.json'), 'utf8')
    expect(text).toContain('\n  "devices"') // 2-space indent
    expect(text).toContain('"version": 1')
  })

  it('warns about a corrupted file but not about a missing one', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const fresh = new DeviceStore(dir('fresh-enoent'))
    await fresh.get('anything-000000')
    expect(warn).not.toHaveBeenCalled()

    const dataDir = dir('warnpath')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord())
    writeFileSync(path.join(dataDir, 'devices.json'), '~~garbage~~')
    const reopened = new DeviceStore(dataDir)
    await reopened.get('device-12345678')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][1]).toBe('Device store corrupt — quarantined, starting fresh')
    warn.mockRestore()
  })

  it('ignores store files whose devices field is not a record', async () => {
    for (const devices of [null, 'nope', [1, 2], 42]) {
      const dataDir = dir(`shape-${String(typeof devices)}`)
      await new DeviceStore(dataDir).upsert(sampleRecord())
      writeFileSync(
        path.join(dataDir, 'devices.json'),
        JSON.stringify({ version: 1, devices }),
      )
      const reopened = new DeviceStore(dataDir)
      expect(await reopened.get('device-12345678')).toBeNull()
    }
  })

  it('survives a failing disk write and keeps serving afterwards', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const dataDir = dir('diskfail')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-diskfail1')) // prime the directory

    const failing = vi.spyOn(fsp, 'writeFile').mockRejectedValueOnce(new Error('EIO'))
    const survived = await store.upsert(sampleRecord('device-diskfail1'))
    expect(survived.deviceId).toBe('device-diskfail1')
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0][1]).toBe('Failed to persist device store')
    expect(String((error.mock.calls[0][0] as Record<string, unknown>).err)).toContain('EIO')
    failing.mockRestore()
    error.mockRestore()

    // The next write must go through the intact queue.
    await store.upsert(sampleRecord('device-diskfail2'))
    expect(await store.get('device-diskfail2')).toBeTruthy()
  })

  it('lists all registered devices', async () => {
    const store = new DeviceStore(dir('list'))
    await store.upsert(sampleRecord('device-listing01'))
    await store.upsert(sampleRecord('device-listing02'))
    const all = await store.list()
    expect(all.map((d) => d.deviceId).sort()).toEqual(['device-listing01', 'device-listing02'])
  })

  it('rounds the timestamps to ISO strings', async () => {
    const store = new DeviceStore(dir('iso'))
    const saved = await store.upsert(sampleRecord())
    expect(saved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('refuses new records once the registry cap is hit (updates still pass)', async () => {
    const store = new DeviceStore(dir('cap'), 2)
    await store.upsert(sampleRecord('device-cap-00001'))
    await store.upsert(sampleRecord('device-cap-00002'))
    await expect(store.upsert(sampleRecord('device-cap-00003'))).rejects.toBeInstanceOf(
      RegistryFullError,
    )
    // Updating an existing record is never blocked by the cap.
    const updated = await store.upsert(sampleRecord('device-cap-00001'))
    expect(updated.deviceId).toBe('device-cap-00001')
  })

  it('prunes expired records on write so a create at the cap reclaims dead slots', async () => {
    // The load-time prune cannot help here: the record ages out while this
    // process lives, so the cap check itself must evict it.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const store = new DeviceStore(dir('prune-write'), 1, 60 * 60 * 1000)
      await store.createIfAbsent(sampleRecord('device-stale-001'))

      // One hour later the only record is expired — a fresh device must
      // reclaim its slot instead of 503-ing until a restart.
      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'))
      const created = await store.createIfAbsent(sampleRecord('device-fresh-001'))
      expect(created.created).toBe(true)
      expect(await store.get('device-stale-001')).toBeNull()
      expect(await store.get('device-fresh-001')).toBeTruthy()

      // A cap full of LIVE records still refuses (no eviction of the living).
      await expect(store.createIfAbsent(sampleRecord('device-fresh-002'))).rejects.toBeInstanceOf(
        RegistryFullError,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('prune-on-write keeps live records — only expired slots are reclaimed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const store = new DeviceStore(dir('prune-live'), 2, 60 * 60 * 1000)
      await store.createIfAbsent(sampleRecord('device-stale-001'))
      vi.setSystemTime(new Date('2026-01-01T01:30:00Z'))
      await store.createIfAbsent(sampleRecord('device-live-001'))
      // At 02:00: stale-001 (00:00) is 2h old — past the 1h max age — while
      // live-001 (01:30) is half an hour old: the cap prune must evict only
      // the dead slot and the survivor must still be served.
      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'))
      const created = await store.createIfAbsent(sampleRecord('device-new-00001'))
      expect(created.created).toBe(true)
      expect(await store.get('device-stale-001')).toBeNull()
      expect(await store.get('device-live-001')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates deeply missing data directories on first persist', async () => {
    const dataDir = dir('deep/a/b/c') // three missing levels
    const store = new DeviceStore(dataDir)
    const saved = await store.upsert(sampleRecord('device-deep00001'))
    const reloaded = new DeviceStore(dataDir)
    expect(await reloaded.get('device-deep00001')).toEqual(saved)
  })

  it('writes the store file owner-only (0600)', async () => {
    const dataDir = dir('perms')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-perms0001'))
    const mode = statSync(path.join(dataDir, 'devices.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('drops prototype-colliding keys when loading a hand-edited store', async () => {
    const dataDir = dir('proto')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-real-0001'))
    const file = path.join(dataDir, 'devices.json')
    // Craft the file at the text level: JSON.parse creates "__proto__" as an
    // own property, which is exactly the smuggling vector being guarded.
    // The evil entries carry a fresh updatedAt so only the key filter —
    // not the TTL prune — stands between them and the live store.
    const evil = (key: string) =>
      `"${key}": { "deviceId": "evil-12345678", "updatedAt": "${new Date().toISOString()}" }`
    const tampered = readFileSync(file, 'utf8').replace(
      '"devices": {',
      `"devices": {\n    ${evil('__proto__')},\n    ${evil('constructor')},\n    ${evil('prototype')},`,
    )
    writeFileSync(file, tampered)

    const reopened = new DeviceStore(dataDir)
    expect(await reopened.get('__proto__')).toBeNull()
    expect(await reopened.get('constructor')).toBeNull()
    expect(await reopened.get('prototype')).toBeNull()
    expect(await reopened.get('device-real-0001')).toBeTruthy()
    // The store remains writable after loading the tampered file.
    await reopened.upsert(sampleRecord('device-real-0002'))
    expect(await reopened.get('device-real-0002')).toBeTruthy()
  })

  it('never resolves lookups through the prototype chain', async () => {
    // A fresh, never-persisted store still uses a normal-prototype object:
    // "constructor", "toString" and friends are inherited properties there
    // and must not masquerade as records.
    const store = new DeviceStore(dir('ownprops'))
    expect(await store.get('constructor')).toBeNull()
    expect(await store.get('toString')).toBeNull()
    expect(await store.delete('constructor')).toBe(false)
    expect(await store.delete('valueOf')).toBe(false)
  })

  it('prunes records older than the registry max age at load', async () => {
    const dataDir = dir('ttl')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-fresh-0001'))
    const file = path.join(dataDir, 'devices.json')

    // Age the record far past a one-hour max age and reload.
    const aged = JSON.parse(readFileSync(file, 'utf8'))
    aged.devices['device-fresh-0001'].updatedAt = new Date(
      Date.now() - 2 * 60 * 60 * 1000,
    ).toISOString()
    writeFileSync(file, JSON.stringify(aged))

    const strict = new DeviceStore(dataDir, 25_000, 60 * 60 * 1000)
    expect(await strict.get('device-fresh-0001')).toBeNull()

    // Within the default 365-day max age the record survives.
    expect(await new DeviceStore(dataDir).get('device-fresh-0001')).toBeTruthy()
  })

  it('prunes records with unparseable timestamps at load', async () => {
    const dataDir = dir('ttl-bad-date')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-baddate1'))
    const file = path.join(dataDir, 'devices.json')
    const tampered = readFileSync(file, 'utf8').replace(
      /"updatedAt": "[^"]+"/,
      '"updatedAt": "not-a-date"',
    )
    writeFileSync(file, tampered)

    expect(await new DeviceStore(dataDir).get('device-baddate1')).toBeNull()
  })

  it('strips the legacy fcmToken field when loading old store files', async () => {
    const dataDir = dir('legacy-fcm')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord('device-legacyfcm'))
    const file = path.join(dataDir, 'devices.json')
    const tampered = readFileSync(file, 'utf8').replace(
      '"deviceId": "device-legacyfcm"',
      '"deviceId": "device-legacyfcm", "fcmToken": "legacy-token-abcd"',
    )
    writeFileSync(file, tampered)

    const record = await new DeviceStore(dataDir).get('device-legacyfcm')
    expect(record).toBeTruthy()
    expect(record).not.toHaveProperty('fcmToken')
  })
})

describe('DeviceStore.updateIfSecretMatches', () => {
  it('applies the update while the hash still matches and preserves an omitted secret', async () => {
    const dataDir = dir('guarded-ok')
    const store = new DeviceStore(dataDir)
    const created = await store.createIfAbsent({ ...sampleRecord(), secretHash: 'h1' })
    expect(created.created).toBe(true)

    const saved = await store.updateIfSecretMatches('device-12345678', 'h1', sampleRecord())
    expect(saved).not.toBeNull()
    // No secretHash in the update → the stored hash survives untouched.
    expect(saved!.secretHash).toBe('h1')
    expect((await store.get('device-12345678'))!.secretHash).toBe('h1')
  })

  it('rejects the write when the stored hash moved on (rotation race guard)', async () => {
    const dataDir = dir('guarded-moved')
    const store = new DeviceStore(dataDir)
    await store.createIfAbsent({ ...sampleRecord(), secretHash: 'h1' })
    // A concurrent rotation already replaced h1 with h2.
    await store.updateIfSecretMatches('device-12345678', 'h1', {
      ...sampleRecord(),
      secretHash: 'h2',
    })
    expect(await store.updateIfSecretMatches('device-12345678', 'h1', sampleRecord())).toBeNull()
    // The stale writer must not have resurrected h1.
    expect((await store.get('device-12345678'))!.secretHash).toBe('h2')
  })

  it('rejects writes for missing devices and reserved keys', async () => {
    const store = new DeviceStore(dir('guarded-missing'))
    expect(await store.updateIfSecretMatches('nobody-123456', 'h', sampleRecord())).toBeNull()
    expect(await store.updateIfSecretMatches('__proto__', 'h', sampleRecord())).toBeNull()
  })
})

describe('DeviceStore transient I/O errors', () => {
  it('fails the call instead of wiping the registry on an unreadable file', async () => {
    const dataDir = dir('ioerror')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord())
    // Break read permission on the persisted file (EACCES ≠ ENOENT ≠ corrupt).
    const file = path.join(dataDir, 'devices.json')
    chmodSync(file, 0o000)

    const reopened = new DeviceStore(dataDir)
    await expect(reopened.get('device-12345678')).rejects.toBeInstanceOf(Error)
    // A later write through the original handle must not have destroyed the
    // data — the failed reader never marked itself loaded.
    chmodSync(file, 0o644)
    expect(readFileSync(file, 'utf8')).toContain('device-12345678')
  })
})

describe('reserved identifiers and the size cap on createIfAbsent', () => {
  it('createIfAbsent refuses reserved identifiers with an error', async () => {
    const store = new DeviceStore(dir('create-reserved'))
    await expect(store.createIfAbsent({ ...sampleRecord('__proto__') })).rejects.toThrow('Reserved device id')
  })

  it('createIfAbsent refuses new records once the cap is reached', async () => {
    const store = new DeviceStore(dir('create-cap'), 2, 365 * 24 * 60 * 60 * 1000)
    await store.createIfAbsent(sampleRecord('device-aaaaaaaaaa'))
    await store.createIfAbsent(sampleRecord('device-bbbbbbbbbb'))
    // The registry is full: a NEW identity is refused…
    await expect(store.createIfAbsent(sampleRecord('device-cccccccccc'))).rejects.toBeInstanceOf(RegistryFullError)
    // …but an existing one still updates in place via the guarded path.
    const updated = await store.updateIfSecretMatches('device-aaaaaaaaaa', undefined, sampleRecord('device-aaaaaaaaaa'))
    expect(updated).not.toBeNull()
  })

  it('upsert refuses reserved identifiers too', async () => {
    const store = new DeviceStore(dir('upsert-reserved'))
    await expect(store.upsert({ ...sampleRecord('constructor') })).rejects.toThrow('Reserved device id')
  })
})

describe('corrupt-file quarantine when the directory is read-only', () => {
  it('still starts fresh when renaming the corrupt file away fails', async () => {
    const dataDir = dir('quarantine-fail')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord())
    writeFileSync(path.join(dataDir, 'devices.json'), '~~garbage~~')
    // Directory without write permission: the quarantine rename now fails,
    // the catch must swallow it, and the store still comes up empty.
    chmodSync(dataDir, 0o555)
    try {
      const reopened = new DeviceStore(dataDir)
      expect(await reopened.get('device-12345678')).toBeNull()
    } finally {
      chmodSync(dataDir, 0o755)
    }
  })
})

describe('version-mismatch quarantine scope and diagnostics', () => {
  it('leaves a v1 file with a junk devices field in place — only a declared foreign version is quarantined', async () => {
    // A file that DECLARES version 1 but fails the shape check is ignored
    // in place, not renamed aside: the quarantine is reserved for a
    // declared foreign version, whose data a future migration may need.
    const dataDir = dir('v1-junk-devices')
    await new DeviceStore(dataDir).upsert(sampleRecord())
    writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify({ version: 1, devices: 'nope' }))

    const reopened = new DeviceStore(dataDir)
    expect(await reopened.get('device-12345678')).toBeNull()
    const files = readdirSync(dataDir)
    expect(files.includes('devices.json')).toBe(true)
    expect(files.some((f) => f.startsWith('devices.json.wrongversion-'))).toBe(false)
  })

  it('warns with the foreign version and the file when quarantining a mismatch', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const dataDir = dir('version-warn')
    await new DeviceStore(dataDir).upsert(sampleRecord())
    const file = path.join(dataDir, 'devices.json')
    writeFileSync(file, JSON.stringify({ version: 99, devices: {} }))

    const reopened = new DeviceStore(dataDir)
    await reopened.get('device-12345678')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][1]).toBe('Device store version mismatch — quarantined, starting fresh')
    expect(warn.mock.calls[0][0]).toMatchObject({ version: '99', file })
    warn.mockRestore()
  })
})

describe('prune-on-write boundaries', () => {
  it('keeps a record exactly AT the cutoff — expiry is strict, not inclusive', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const store = new DeviceStore(dir('prune-boundary'), 1, 60 * 60 * 1000)
      await store.createIfAbsent(sampleRecord('device-atcutoff1'))

      // Exactly one max-age later the cutoff EQUALS the record's updatedAt
      // instant: max age is "not updated within", so the record is still
      // live and the cap stays genuinely full.
      vi.setSystemTime(new Date('2026-01-01T01:00:00Z'))
      await expect(
        store.createIfAbsent(sampleRecord('device-later-0001')),
      ).rejects.toBeInstanceOf(RegistryFullError)
      expect(await store.get('device-atcutoff1')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not prune below the cap — reclamation engages only under slot pressure', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const store = new DeviceStore(dir('prune-lazy'), 5, 60 * 60 * 1000)
      await store.createIfAbsent(sampleRecord('device-oldslot01'))

      // Hours later the record is long expired, but the registry is nearly
      // empty: without cap pressure the expired slot stays (load-time
      // pruning and pressure pruning are the only eviction points).
      vi.setSystemTime(new Date('2026-01-01T03:00:00Z'))
      await store.createIfAbsent(sampleRecord('device-newslot01'))
      expect(await store.get('device-oldslot01')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
