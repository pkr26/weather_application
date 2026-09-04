import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
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

  it('ignores a store file with an unexpected version', async () => {
    const dataDir = dir('version')
    const store = new DeviceStore(dataDir)
    await store.upsert(sampleRecord())
    const file = path.join(dataDir, 'devices.json')
    writeFileSync(file, JSON.stringify({ version: 99, devices: { junk: true } }))

    const reopened = new DeviceStore(dataDir)
    expect(await reopened.get('device-12345678')).toBeNull()
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
    expect(warn.mock.calls[0][1]).toBe('Device store unreadable, starting fresh')
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
