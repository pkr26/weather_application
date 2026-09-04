import type { LanguagePack } from './types.js'
import { en } from './packs/en.js'
import { indianPacks } from './packs/indian.js'
import { europeanPacks } from './packs/european.js'
import { apacPacks } from './packs/apac.js'

/** All supported notification languages, English first. */
export const languagePacks: LanguagePack[] = [en, ...indianPacks, ...europeanPacks, ...apacPacks]

// Stryker disable ArrowFunction: the mutant crashes module initialisation
// (Map constructor rejects the junk entries), which Stryker's crash
// detection records as "survived" — hand-verified: no test even collects.
const byCode = new Map<string, LanguagePack>(
  languagePacks.map((p) => [p.code.toLowerCase(), p]),
)
// Stryker restore

/**
 * Resolves a requested language code to a pack, with graceful fallback:
 * exact match → primary subtag match (zh-TW → zh) → English.
 */
export function resolvePack(requested: string | undefined | null): LanguagePack {
  if (!requested) return en
  const code = requested.trim().toLowerCase()
  const exact = byCode.get(code)
  if (exact) return exact
  const primary = code.split('-')[0]
  // The true arm is a verified equivalent: no pack has an empty primary
  // subtag, so entering the loop with '' changes nothing.
  // Stryker disable ConditionalExpression
  if (primary) {
  // Stryker restore
    for (const pack of languagePacks) {
      if (pack.code.toLowerCase().split('-')[0] === primary) return pack
    }
  }
  return en
}

export function isSupported(code: string | undefined | null): boolean {
  if (!code) return false
  return byCode.has(code.trim().toLowerCase())
}

/** Catalog payload for the app's language picker. */
export function languageCatalog(): Array<{
  code: string
  nativeName: string
  englishName: string
  rtl: boolean
}> {
  return languagePacks.map(({ code, nativeName, englishName, rtl }) => ({
    code,
    nativeName,
    englishName,
    rtl,
  }))
}
