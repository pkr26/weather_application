# Contributing to Cirrus

Thanks for helping make Cirrus better!

## Setup

1. **Backend** (Node 22+): `cd backend && cp .env.example .env && npm install`
2. **Android**: open the project in Android Studio (AGP 8.7+, JDK 17) — the
   SDK is expected at the path in `local.properties`.

## Before opening a PR

```bash
# Backend
cd backend && npm run typecheck && npm test && npm run audit

# Android
./gradlew :core:test :app:testDebugUnitTest :app:lintDebug assembleDebug
```

CI additionally runs mutation testing on both sides (Stryker gate 98% of
scored mutants, PIT gate 98%) — run `npm run mutation` / `./gradlew :core:pitest`
locally if you touch logic those suites cover.

## Ground rules

- Every user-facing string goes in `strings.xml` (backend: the i18n packs) —
  nothing hardcoded, so every language stays first-class.
- New backend endpoints get zod validation + tests; new Android logic goes in
  `:core` (pure JVM, mutation-tested) whenever it doesn't need framework types.
- Behavior changes deserve a test that would fail without them.
- Security-relevant changes: check them against SECURITY.md's threat model
  and keep the control-to-test matrix current.

## Reporting security issues

See SECURITY.md — please report privately, not via public issues.
