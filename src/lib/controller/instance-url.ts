// ============================================================
// instance-url.ts — Registry URL normalization + SSRF guard (FR-B8)
//
// Rules (PRD §7 Epic B):
//   - https:// only for public targets; no trailing slash, no path,
//     no query, no fragment, no user:pass@
//   - private/loopback/link-local hosts (isPrivateIP — reuses the
//     instance app's battle-tested classifier) are rejected unless
//     ALLOW_PRIVATE_TARGETS=true (local-dev override);
//     the override also permits plain http and non-443 ports for
//     PRIVATE targets only
//   - public hostnames are DNS-resolved and every resolved IP is
//     re-checked against the private ranges (DNS-rebinding-style
//     literal hiding)
//   - non-443 explicit ports on public hosts are rejected
//
// Output is the canonical registry form: scheme://host[:port]
// ============================================================

import dns from 'dns/promises'
import { isPrivateIP } from '@/lib/core/is-private-ip'
import { allowPrivateInstanceTargets } from './config'

export type UrlValidation =
  | { ok: true; url: string; privateTarget: boolean }
  | { ok: false; error: string }

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** Validate a color tag for instance badges (null clears it). */
export function normalizeColorTag(value: unknown): string | null | { error: string } {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    return { error: 'Warna harus berupa kode hex, misalnya #ff5c00' }
  }
  return value.toLowerCase()
}

/** Validate/normalize a menfess handle (display only). */
export function normalizeHandle(value: unknown): string | null | { error: string } {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return { error: 'Handle tidak valid' }
  const trimmed = value.trim().replace(/^@+/, '')
  if (trimmed.length === 0) return null
  if (!/^[A-Za-z0-9_]{1,15}$/.test(trimmed)) {
    return { error: 'Handle X hanya boleh huruf, angka, dan garis bawah (maks 15)' }
  }
  return trimmed
}

export async function validateInstanceBaseUrl(raw: unknown): Promise<UrlValidation> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: 'URL wajib diisi' }
  }

  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'URL tidak valid' }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL tidak boleh mengandung kredensial (user:pass@)' }
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { ok: false, error: 'URL harus berupa origin saja (tanpa path, query, atau fragment)' }
  }

  const host = parsed.hostname.toLowerCase()
  const privateOverride = allowPrivateInstanceTargets()
  const isPrivateHost = isPrivateIP(host)

  if (isPrivateHost) {
    if (!privateOverride) {
      return {
        ok: false,
        error: 'Host privat/lokal tidak diizinkan. Set ALLOW_PRIVATE_TARGETS=true untuk development lokal.',
      }
    }
    // Private override lane: http allowed, any port allowed.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: 'Protokol harus http atau https' }
    }
  } else {
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'URL instance harus menggunakan https://' }
    }
    if (parsed.port && parsed.port !== '443') {
      return { ok: false, error: 'Port non-443 tidak diizinkan untuk target publik' }
    }
    // DNS resolution guard: every resolved address must be public.
    try {
      const records = await dns.lookup(host, { all: true })
      if (records.length === 0) {
        return { ok: false, error: 'Hostname tidak dapat diselesaikan (DNS)' }
      }
      for (const record of records) {
        if (isPrivateIP(record.address)) {
          return { ok: false, error: 'Hostname resolving ke IP privat tidak diizinkan' }
        }
      }
    } catch {
      return { ok: false, error: 'Hostname tidak dapat diselesaikan (DNS)' }
    }
  }

  // Canonical form: strip default ports, keep explicit non-defaults (private lane).
  const port = parsed.port && parsed.port !== '443' ? `:${parsed.port}` : ''
  const url = `${parsed.protocol}//${host}${port}`
  return { ok: true, url, privateTarget: isPrivateHost }
}
