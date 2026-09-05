/**
 * Loads backend/.env (plain key=value, no shell features) before any other
 * module reads process.env. Must be imported FIRST by index.ts: ESM
 * evaluates static imports depth-first, so a loadEnvFile call in the index
 * body would run only AFTER app.ts — and the pino logger it pulls in, which
 * reads LOG_LEVEL at module scope — has already initialized. Existing real
 * environment variables win over .env values (process.loadEnvFile never
 * overrides what the environment already set).
 *
 * Deliberately import-free: importing the logger here (even for the warning
 * below) would recreate the exact hoisting problem this module solves.
 */
// Excluded from mutation testing in stryker.config.json, the same as
// index.ts: this bootstrap side-effect module runs before the test runner
// imports anything, so no mutant here is observable from the suite.
try {
  // process.loadEnvFile exists only on Node >= 20.12 — probe before calling
  // so older 20.x fails with the honest env error instead of a TypeError.
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile()
} catch (err) {
  // A missing .env is the normal case (the file is optional); anything else
  // is a real parse or I/O problem, but the logger does not exist yet —
  // the raw console is the only channel available this early.
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn('Could not load .env — relying on real environment variables', err)
  }
}
