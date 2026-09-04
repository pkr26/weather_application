import type { Config } from '../config.js'
import { fetchJsonWithRetry } from './http.js'

/**
 * City-search proxy over the free Open-Meteo geocoding API (keyless), plus
 * reverse geocoding over BigDataCloud's keyless client endpoint — the
 * fallback the Android app uses when the on-device Geocoder has no backend.
 * Both share the global upstream retry policy (5xx retried with backoff,
 * 4xx and network errors surfaced immediately).
 */
export class GeocodingClient {
  constructor(private readonly config: Config) {}

  async search(query: string, count = 12): Promise<unknown> {
    const url = new URL('v1/search', this.config.GEOCODING_API_BASE)
    url.searchParams.set('name', query)
    url.searchParams.set('count', String(count))
    url.searchParams.set('language', 'en')
    url.searchParams.set('format', 'json')

    return fetchJsonWithRetry({
      url,
      timeoutMs: this.config.UPSTREAM_TIMEOUT_MS,
      retries: this.config.UPSTREAM_RETRIES,
      backoffMs: this.config.UPSTREAM_RETRY_BACKOFF_MS,
      label: 'Geocoding API',
    })
  }

  /**
   * Resolves coordinates to a place name. Fields are nullable — the client
   * treats a null name as "keep the generic label" rather than an error.
   */
  async reverse(latitude: number, longitude: number): Promise<unknown> {
    const url = new URL('data/reverse-geocode-client', this.config.REVERSE_GEOCODING_API_BASE)
    url.searchParams.set('latitude', String(latitude))
    url.searchParams.set('longitude', String(longitude))
    url.searchParams.set('localityLanguage', 'en')

    const raw = (await fetchJsonWithRetry({
      url,
      timeoutMs: this.config.UPSTREAM_TIMEOUT_MS,
      retries: this.config.UPSTREAM_RETRIES,
      backoffMs: this.config.UPSTREAM_RETRY_BACKOFF_MS,
      label: 'Reverse geocoding',
    })) as Record<string, unknown>
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' ? v : null
    return {
      name:
        str(raw.city) ??
        str(raw.locality) ??
        str(raw.principalSubdivision),
      admin1: str(raw.principalSubdivision),
      country: str(raw.countryName),
    }
  }
}
