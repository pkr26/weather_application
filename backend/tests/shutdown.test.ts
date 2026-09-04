import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * index.ts is excluded from unit coverage — the drain path (SIGTERM →
 * readiness 503 → closeIdleConnections → clean exit) only exists at process
 * level. This boots the real server, moves it, and asserts the shutdown
 * contract an orchestrator depends on.
 */

const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'cirrus-shutdown-test-'))
afterAll(() => rmSync(tmpDataDir, { recursive: true, force: true }))

/** Boots `tsx src/index.ts` on an ephemeral port; resolves when listening. */
async function bootServer(): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(import.meta.dirname, '..', 'src', 'index.ts')],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: tmpDataDir,
        WEATHER_API_KEY: 'test-key',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams
  let output = ''
  const collect = (chunk: Buffer) => {
    output += chunk.toString()
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (/listening/.test(output)) {
      // Wait until the socket actually accepts (listen callback logged first).
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) })
        if (probe.ok) return { child, port }
      } catch {
        // not accepting yet — keep waiting
      }
    }
    if (child.exitCode !== null) throw new Error(`server exited during boot: ${output}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill('SIGKILL')
  throw new Error(`server never came up: ${output}`)
}

describe('index.ts process lifecycle', () => {
  it('SIGTERM drains and exits 0', async () => {
    const { child } = await bootServer()

    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
    })
    child.kill('SIGTERM')

    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('process did not exit within 10 s')), 10_000),
      ),
    ])
    expect(code).toBe(0)
  }, 30_000)
})
