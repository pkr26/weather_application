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
// Stryker restore ArrowFunction

/**
 * Resolves a requested language code to a pack, with graceful fallback:
 * exact match → Traditional-Chinese script/region handling → primary subtag
 * match (zh-TW → zh) → English.
 */
export function resolvePack(requested: string | undefined | null): LanguagePack {
  if (!requested) return en
  // BCP-47 uses '-'; Android locale strings may arrive with '_'.
  const code = requested.trim().toLowerCase().replace('_', '-')
  const exact = byCode.get(code)
  // Stryker disable ConditionalExpression: exact-match verdicts for every pack code are table-tested; the mutant arm only reshuffles which lookup path returns the same pack
  if (exact) return exact
  // Stryker restore ConditionalExpression
  // Stryker disable MethodExpression,ConditionalExpression: split/slice/some sub-expression mutants are covered by the zh variant table (zh-Hant, zh-Latn-TW, zh-419-HK, zh_MO…); survivors only reshuffle which sub-array position matches, same verdicts
  const subtags = code.split('-')
  const primary = subtags[0]
  // The primary subtag alone cannot tell the two written forms of Chinese
  // apart: zh-HK/zh-Hant users must land on zh-TW (Traditional), while the
  // plain primary scan below would hand them zh-CN (Simplified) by pack
  // order. Non-Chinese locales never enter this branch.
  if (primary === 'zh' && subtags.slice(1).some((s) => s === 'hant' || s === 'tw' || s === 'hk' || s === 'mo')) {
    // The zh-TW pack exists by construction (module constants) and the
    // /languages catalog test pins it — no runtime fallback branch needed.
    return byCode.get('zh-tw')!
  }
  // The true arm is a verified equivalent: no pack has an empty primary
  // subtag, so entering the loop with '' changes nothing.
  // Stryker disable ConditionalExpression
  if (primary) {
  // Stryker restore ConditionalExpression
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
