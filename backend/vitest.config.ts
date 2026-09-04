import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runs before any test module (and its imports) — silences pino for the
    // whole suite regardless of import order.
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: [
        'src/i18n/packs/**',
        // Server bootstrap: binds a port and installs signal handlers —
        // exercised by the Docker healthcheck, not unit-testable.
        'src/index.ts',
      ],
      // Every file must clear 98% on lines, branches, functions and
      // statements — aggregate numbers hide files the suite forgot.
      thresholds: {
        lines: 98,
        branches: 98,
        functions: 98,
        statements: 98,
        perFile: true,
      },
    },
  },
})
