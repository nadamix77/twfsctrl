// ============================================================
// instance-client.ts — Server-side client for Tweetfess instances
// (PRD §10 Instance API Integration Contract)
//
// The ONLY module that talks to instance deployments. Browser code
// never calls instance domains (design rule §6.2.2): tokens live in
// a server-side in-memory cache (NFR-S2), never in cookies/DB/logs.
//
// Lifecycle (PRD §10.1):
//   - login → token cached (7-day TTL, parsed from the token itself)
//   - every call → Authorization: Bearer <token>
//   - 401 → drop cache → single-flight re-login → retry ONCE
//   - login 401 → 'auth-failed'; login 429 → 'locked-out' (+Retry-After,
//     remembered per target so we never hammer a locked instance)
//   - timeout (8 s, AbortController) / DNS / 5xx → 'down'
//
// CSRF note: the instance origin-guard (src/lib/core/origin-guard.ts)
// REQUIRES an Origin or Referer header even on server-to-server POSTs,
// so login calls send `Origin: <instance origin>` — always same-origin
// by construction, exactly what the guard accepts.
// ============================================================

import type { InstanceHealth } from './types'

export const INSTANCE_CALL_TIMEOUT_MS = 8_000
const TOKEN_EXPIRY_SAFETY_MS = 60_000

/** Everything the client needs to reach one instance. `password` is the
 *  decrypted ADMIN_PASSWORD (decryption happens per request, NFR-S1). */
export interface InstanceTarget {
  key: string // cache key: instance id, or `test:<baseUrl>` for unsaved probes
  baseUrl: string
  password: string | null
}

export type InstanceCallFailure = {
  ok: false
  kind: Extract<InstanceHealth, 'auth-failed' | 'locked-out' | 'down'>
  status: number
  error: string
  retryAfterSec: number | null
}

export type InstanceCallSuccess = {
  ok: true
  status: number
  body: unknown
}

export type InstanceCallResult = InstanceCallSuccess | InstanceCallFailure

export type LoginOutcome =
  | { ok: true; token: string }
  | InstanceCallFailure

// ── Token cache + single-flight login (in-memory only, NFR-S2) ──

interface CachedToken {
  token: string
  expiresAtMs: number
}

const globalForCache = globalThis as unknown as {
  __controllerTokenCache?: Map<string, CachedToken>
  __controllerLoginInFlight?: Map<string, Promise<LoginOutcome>>
  __controllerLoginLockout?: Map<string, number> // key → retry-not-before epoch ms
}

const tokenCache = (globalForCache.__controllerTokenCache ??= new Map())
const loginInFlight = (globalForCache.__controllerLoginInFlight ??= new Map())
const loginLockout = (globalForCache.__controllerLoginLockout ??= new Map())

/** Drop the cached token for a target (credential save, 401, disable). */
export function dropCachedToken(key: string): void {
  tokenCache.delete(key)
  loginLockout.delete(key)
}

export function dropAllCachedTokens(): void {
  tokenCache.clear()
  loginLockout.clear()
}

// ── Low-level fetch with timeout + safe JSON parse ───────────

interface RawResponse {
  status: number
  body: unknown
  retryAfterSec: number | null
  getSetCookie(): string[]
}

async function fetchInstance(target: InstanceTarget, path: string, init?: RequestInit): Promise<{ ok: true; res: RawResponse } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, INSTANCE_CALL_TIMEOUT_MS)
  try {
    const res = await fetch(`${target.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      // No Origin/Referer from Node fetch by default — the instance
      // origin-guard rejects header-less POSTs, so every mutating call
      // wears the instance's own origin (same-origin by construction).
      headers: {
        Accept: 'application/json',
        ...init?.headers,
        ...(init?.method && init.method !== 'GET' ? { Origin: target.baseUrl } : {}),
      },
      redirect: 'error', // a redirect means this is not a Tweetfess instance
      cache: 'no-store',
    })

    const retryAfterRaw = res.headers.get('retry-after')
    const retryAfterSec = retryAfterRaw ? Math.max(0, parseInt(retryAfterRaw, 10) || 0) : null

    let body: unknown = null
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      try {
        body = await res.json()
      } catch {
        body = null
      }
    }

    const getSetCookie = () =>
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []

    return { ok: true, res: { status: res.status, body, retryAfterSec, getSetCookie } }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      ok: false,
      error: aborted
        ? `Instance tidak merespons dalam ${Math.round(INSTANCE_CALL_TIMEOUT_MS / 1000)} detik`
        : 'Instance tidak dapat dijangkau (DNS/jaringan)',
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── Binary fetch (media proxy) ───────────────────────────────

export interface RawBinaryResult {
  status: number
  contentType: string | null
  etag: string | null
  buffer: ArrayBuffer | null
}

/** Raw binary GET against an instance (auth-gated media). Shares the
 *  timeout ceiling; used only by the controller media proxy. */
async function fetchInstanceBinary(
  target: InstanceTarget,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: true; res: RawBinaryResult } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, INSTANCE_CALL_TIMEOUT_MS)
  try {
    const res = await fetch(`${target.baseUrl}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { ...extraHeaders },
      redirect: 'error',
      cache: 'no-store',
    })
    if (res.status === 304) {
      return { ok: true, res: { status: 304, contentType: null, etag: res.headers.get('etag'), buffer: null } }
    }
    const buffer = await res.arrayBuffer()
    return {
      ok: true,
      res: {
        status: res.status,
        contentType: res.headers.get('content-type'),
        etag: res.headers.get('etag'),
        buffer,
      },
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      ok: false,
      error: aborted
        ? `Instance tidak merespons dalam ${Math.round(INSTANCE_CALL_TIMEOUT_MS / 1000)} detik`
        : 'Instance tidak dapat dijangkau (DNS/jaringan)',
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── Login (single-flight) ────────────────────────────────────

/** Extract the embedded expiry from an instance token `<hmac>.<expiresAtHex>`. */
function tokenExpiryMs(token: string): number | null {
  const dot = token.lastIndexOf('.')
  if (dot === -1) return null
  const expiresAt = parseInt(token.slice(dot + 1), 16)
  return isNaN(expiresAt) ? null : expiresAt * 1000
}

/** Parse `admin_token` out of Set-Cookie headers; also honor Max-Age. */
function extractTokenFromCookies(setCookies: string[]): { token: string; maxAgeSec: number | null } | null {
  for (const header of setCookies) {
    const parts = header.split(';').map((p) => p.trim())
    const nameValue = parts[0] ?? ''
    const eq = nameValue.indexOf('=')
    if (eq === -1) continue
    if (nameValue.slice(0, eq) !== 'admin_token') continue
    const token = nameValue.slice(eq + 1)
    if (!token) return null
    let maxAgeSec: number | null = null
    for (const attr of parts.slice(1)) {
      const [k, v] = attr.split('=')
      if (k?.toLowerCase() === 'max-age' && v) {
        const parsed = parseInt(v, 10)
        if (!isNaN(parsed)) maxAgeSec = parsed
      }
    }
    return { token, maxAgeSec }
  }
  return null
}

function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error
    if (typeof err === 'string' && err.length > 0) return err
  }
  return fallback
}

async function performLogin(target: InstanceTarget): Promise<LoginOutcome> {
  // Lockout memory (C1/E3): never retry a login while the instance
  // has told us to wait — each attempt burns the per-IP budget.
  const notBefore = loginLockout.get(target.key)
  if (notBefore && Date.now() < notBefore) {
    return {
      ok: false,
      kind: 'locked-out',
      status: 429,
      error: 'Login instance terkunci setelah percobaan gagal berulang',
      retryAfterSec: Math.ceil((notBefore - Date.now()) / 1000),
    }
  }
  loginLockout.delete(target.key)

  if (!target.password) {
    return { ok: false, kind: 'auth-failed', status: 0, error: 'Password instance belum tersimpan', retryAfterSec: null }
  }

  const result = await fetchInstance(target, '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: target.password }),
  })
  if (!result.ok) {
    return { ok: false, kind: 'down', status: 0, error: result.error, retryAfterSec: null }
  }

  const { status, body, retryAfterSec, getSetCookie } = result.res

  if (status === 200) {
    const extracted = extractTokenFromCookies(getSetCookie())
    if (!extracted) {
      return {
        ok: false,
        kind: 'auth-failed',
        status: 200,
        error: 'Login berhasil tetapi token tidak diterima (Set-Cookie admin_token hilang)',
        retryAfterSec: null,
      }
    }
    const fromToken = tokenExpiryMs(extracted.token)
    const fromMaxAge = extracted.maxAgeSec != null ? Date.now() + extracted.maxAgeSec * 1000 : null
    const candidates = [fromToken, fromMaxAge].filter((v): v is number => v != null)
    const expiresAtMs = (candidates.length > 0 ? Math.min(...candidates) : Date.now() + 7 * 86_400_000) - TOKEN_EXPIRY_SAFETY_MS
    tokenCache.set(target.key, { token: extracted.token, expiresAtMs })
    return { ok: true, token: extracted.token }
  }

  if (status === 401) {
    return { ok: false, kind: 'auth-failed', status, error: errorText(body, 'Password salah'), retryAfterSec: null }
  }

  if (status === 429) {
    const waitMs = (retryAfterSec ?? 900) * 1000
    loginLockout.set(target.key, Date.now() + waitMs)
    return {
      ok: false,
      kind: 'locked-out',
      status,
      error: errorText(body, 'Terlalu banyak percobaan login. Coba lagi nanti.'),
      retryAfterSec: retryAfterSec ?? Math.ceil(waitMs / 1000),
    }
  }

  if (status === 404) {
    return { ok: false, kind: 'down', status, error: 'Endpoint login tidak ditemukan — apakah ini deployment Tweetfess?', retryAfterSec: null }
  }

  return { ok: false, kind: 'down', status, error: errorText(body, `Instance menjawab ${status}`), retryAfterSec: null }
}

/** Single-flight login: concurrent callers share one in-flight login
 *  (PRD §10.1.5 — no login storms against the 5/15-min instance budget). */
function login(target: InstanceTarget): Promise<LoginOutcome> {
  const existing = loginInFlight.get(target.key)
  if (existing) return existing

  const flight = performLogin(target).finally(() => {
    loginInFlight.delete(target.key)
  })
  loginInFlight.set(target.key, flight)
  return flight
}

// ── Authenticated call with 401 → re-login → retry-once ──────

async function callWithToken(target: InstanceTarget, token: string, path: string, init?: RequestInit): Promise<InstanceCallResult> {
  const result = await fetchInstance(target, path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  })
  if (!result.ok) {
    return { ok: false, kind: 'down', status: 0, error: result.error, retryAfterSec: null }
  }
  return { ok: true, status: result.res.status, body: result.res.body }
}

/**
 * Call an instance API endpoint with the cached admin token.
 * Handles the full token lifecycle (§10.1). `body` is returned for
 * ANY HTTP status — the caller classifies (e.g. 409 CAS, 503 breaker).
 */
export async function callInstance(
  target: InstanceTarget,
  path: string,
  init?: RequestInit,
): Promise<InstanceCallResult> {
  const cached = tokenCache.get(target.key)
  let token: string
  if (cached && cached.expiresAtMs > Date.now()) {
    token = cached.token
  } else {
    tokenCache.delete(target.key)
    const loginResult = await login(target)
    if (!loginResult.ok) return loginResult
    token = loginResult.token
  }

  const first = await callWithToken(target, token, path, init)

  // 401 → one transparent re-login + retry (E4).
  if (first.ok && first.status === 401) {
    tokenCache.delete(target.key)
    const reLogin = await login(target)
    if (!reLogin.ok) return reLogin
    return callWithToken(target, reLogin.token, path, init)
  }

  return first
}

// ── Connection test (FR-B2) ──────────────────────────────────

/** Login + session probe against an arbitrary (not-yet-saved) URL.
 *  Uses its own cache key so tests never poison saved-instance tokens. */
export async function testInstanceConnection(
  baseUrl: string,
  password: string,
): Promise<LoginOutcome> {
  return login({ key: `test:${baseUrl}`, baseUrl, password })
}

// ── Media proxy fetch (auth-gated instance images) ──────────

export type MediaFetchResult =
  | { ok: true; status: number; contentType: string | null; etag: string | null; buffer: ArrayBuffer | null }
  | InstanceCallFailure

/** GET a binary media object with the same token lifecycle as
 *  callInstance (cache → 401 → re-login → retry). `ifNoneMatch` is
 *  forwarded so browser 304 revalidations stay free (instance media
 *  route compares against the stored SHA-256 before any B2 hit). */
export async function callInstanceMedia(
  target: InstanceTarget,
  path: string,
  ifNoneMatch?: string | null,
): Promise<MediaFetchResult> {
  const obtainToken = async (): Promise<string | InstanceCallFailure> => {
    const cached = tokenCache.get(target.key)
    if (cached && cached.expiresAtMs > Date.now()) return cached.token
    tokenCache.delete(target.key)
    const loginResult = await login(target)
    return loginResult.ok ? loginResult.token : loginResult
  }

  let token = await obtainToken()
  if (typeof token !== 'string') return token

  const attempt = async (): Promise<MediaFetchResult> => {
    const result = await fetchInstanceBinary(target, path, {
      Authorization: `Bearer ${token}`,
      ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
    })
    if (!result.ok) return { ok: false, kind: 'down', status: 0, error: result.error, retryAfterSec: null }
    return {
      ok: true,
      status: result.res.status,
      contentType: result.res.contentType,
      etag: result.res.etag,
      buffer: result.res.buffer,
    }
  }

  const first = await attempt()
  if (first.ok && first.status === 401) {
    tokenCache.delete(target.key)
    const reLogin = await login(target)
    if (!reLogin.ok) return reLogin
    token = reLogin.token
    return attempt()
  }
  return first
}

/** After a successful test login, probe the session endpoint for the
 *  "Terhubung — N pending" hint (PRD B3 flow). */
export async function probeSessionPending(target: InstanceTarget): Promise<number | null> {
  const call = await callInstance(target, '/api/admin/session')
  if (!call.ok) return null
  const stats = (call.body as { stats?: { pending?: unknown } } | null)?.stats
  const pending = stats?.pending
  return typeof pending === 'number' ? pending : null
}
