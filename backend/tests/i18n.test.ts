import { describe, expect, it } from 'vitest'
import { languagePacks, resolvePack, languageCatalog, isSupported } from '../src/i18n/index.js'
import { en } from '../src/i18n/packs/en.js'
import { fmt } from '../src/i18n/types.js'
import type { WeatherStrings } from '../src/i18n/types.js'

const referenceKeys = Object.keys(en.t) as Array<keyof WeatherStrings>

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
}

describe('language packs', () => {
  it('exposes at least 20 languages', () => {
    expect(languagePacks.length).toBeGreaterThanOrEqual(20)
  })

  it('has unique language codes', () => {
    const codes = languagePacks.map((p) => p.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it.each(languagePacks.map((p) => [p.code, p] as const))(
    '%s: covers every English key',
    (_code, pack) => {
      for (const key of referenceKeys) {
        expect(pack.t[key], `${pack.code}.${key}`).toBeTruthy()
      }
    },
  )

  it.each(languagePacks.map((p) => [p.code, p] as const))(
    '%s: keeps the same placeholders as English',
    (_code, pack) => {
      for (const key of referenceKeys) {
        expect(placeholders(pack.t[key]), `${pack.code}.${key}`).toEqual(
          placeholders(en.t[key]),
        )
      }
    },
  )

  it('marks Arabic and Urdu as RTL', () => {
    expect(resolvePack('ar').rtl).toBe(true)
    expect(resolvePack('ur').rtl).toBe(true)
    expect(resolvePack('en').rtl).toBe(false)
  })
})

describe('resolvePack', () => {
  it('resolves exact codes case-insensitively', () => {
    expect(resolvePack('ZH-TW').code).toBe('zh-TW')
    expect(resolvePack('te').nativeName).toBe('తెలుగు')
  })

  it('trims surrounding whitespace before resolving', () => {
    expect(resolvePack(' te ').code).toBe('te')
  })

  it('falls back to the primary subtag', () => {
    expect(resolvePack('zh-HK').code.startsWith('zh')).toBe(true)
  })

  it('falls back to English for unknown/missing codes', () => {
    expect(resolvePack('xx').code).toBe('en')
    expect(resolvePack(undefined).code).toBe('en')
    expect(resolvePack('').code).toBe('en')
  })

  it('trims before checking support', () => {
    expect(isSupported(' te ')).toBe(true)
    expect(isSupported(' xx ')).toBe(false)
  })

  it('survives codes that are nothing but a separator', () => {
    expect(resolvePack('-').code).toBe('en')
    expect(resolvePack('  -  ').code).toBe('en')
  })
})

describe('languageCatalog', () => {
  it('lists native and English names for the picker', () => {
    const catalog = languageCatalog()
    const telugu = catalog.find((l) => l.code === 'te')
    expect(telugu).toMatchObject({ nativeName: 'తెలుగు', englishName: 'Telugu' })
  })
})

describe('isSupported', () => {
  it('accepts known codes case-insensitively and rejects everything else', () => {
    expect(isSupported('en')).toBe(true)
    expect(isSupported('TE')).toBe(true)
    expect(isSupported('xx')).toBe(false)
    expect(isSupported(undefined)).toBe(false)
  })
})

describe('fmt', () => {
  it('substitutes every provided placeholder', () => {
    expect(fmt('High {high}, low {low}', { high: '30°', low: '21°' })).toBe('High 30°, low 21°')
    expect(fmt('{p} percent', { p: 80 })).toBe('80 percent')
  })

  it('leaves placeholders without a value untouched', () => {
    // A value that is absent must survive verbatim, never become
    // "undefined" — copy packs drive notification text.
    expect(fmt('Rain at {time}', {})).toBe('Rain at {time}')
    expect(fmt('{a} {b}', { a: 'x' })).toBe('x {b}')
  })

  it('does not re-expand placeholders inside substituted values', () => {
    expect(fmt('{city}', { city: '{high}' })).toBe('{high}')
  })
})
