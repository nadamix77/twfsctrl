// ============================================================
// login-rate-limit.ts — IP-based rate limiter for admin login
// ============================================================
// Prevents brute-force attacks by limiting login attempts per IP.
//
// Record-at-check: consumeLoginAttempt is the ONLY mutation call —
// it reads AND counts in one synchronous step, so the check and its
// use cannot interleave (a check-then-record pair straddling the
// route's parse-await would let a concurrent burst all pass a cold
// counter). Every attempt shape consumes — wrong password, empty
// body, malformed JSON — the attempt itself is the signal; a
// successful login clears the ledger.
//
// Uses in-memory storage (Map + TTL). On Vercel serverless, state
// resets on cold starts — but this is acceptable because:
//   1. Admin login is very low traffic (one admin)
//   2. Even per-instance limits make rapid-fire brute-force impractical
//   3. Each instance allows 5 attempts / 15 min — an attacker would
//      need to hit hundreds of distinct instances to brute-force
//
// For multi-instance coordination, swap this with a DB-backed store
// (e.g. the LoginAttempt model in Prisma).
// ============================================================

import { MINUTE_MS } from '@/lib/core/time-constants'
import { LIMITER_STORE_MAX_ENTRIES } from '@/lib/core/constants'
import { setBounded } from '@/lib/core/bounded-map'

interface AttemptRecord {
  count: number
  firstAttemptAt: number // epoch ms
}

/** Max login attempts per window */
const MAX_ATTEMPTS = 5

/** Time window in ms (15 minutes) */
const WINDOW_MS = 15 * MINUTE_MS

/** Lockout duration in ms (30 minutes — longer than the window) */
const LOCKOUT_MS = 30 * MINUTE_MS

// In-memory store: IP → AttemptRecord
const store = new Map<string, AttemptRecord>()

// Periodic cleanup: prune expired entries every 10 minutes
let lastCleanup = Date.now()
const CLEANUP_INTERVAL_MS = 10 * MINUTE_MS

function cleanup() {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  for (const [ip, record] of store) {
    if (now - record.firstAttemptAt > LOCKOUT_MS) {
      store.delete(ip)
    }
  }
}

/**
 * Extract client IP from request headers.
 * Vercel provides x-forwarded-for and x-real-ip.
 *
 * Takes the Headers object (not the Request) so server components —
 * which have `await headers()` but no Request — can call it too.
 */
export function getClientIp(headers: Headers): string {
  // Vercel sets x-real-ip to the connecting client IP — always present, never spoofable.
  const realIp = headers.get('x-real-ip')
  if (realIp) return realIp.trim()

  // Fallback for non-Vercel environments: rightmost IP in x-forwarded-for
  // is set by the trusted edge proxy (unlike leftmost, which can be client-spoofed).
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean)
    return ips[ips.length - 1] ?? 'unknown'
  }

  return 'unknown'
}

// ── Shared record-at-check engine ─────────────────────────────────
// consumeLoginAttempt and consumeOAuthAttempt are the same state machine
// with different knobs — one engine, two configs. The lockoutMs key is
// the whole difference: when present (login), a window that expired AT
// the limit keeps denying until the lockout elapses; when absent (OAuth),
// a window that expired resets EVEN at the limit. Never give the OAuth
// consumer a lockout — its 10-per-15-min budget is the only bound, and
// a lockout would lock a shared-IP NAT out of login entirely.

/** Ledger knobs shared by the record-at-check consumers. */
interface AttemptLedgerConfig {
  maxAttempts: number
  windowMs: number
  /** Post-window lockout. Absent = window expiry resets even at the limit. */
  lockoutMs?: number
}

/** One attempt decision: allowed (and counted), or denied with the
 *  seconds left until the ledger resets. Denied calls never mutate the
 *  record, so retryAfterSec always counts down to the same end. */
type AttemptDecision = { allowed: true } | { allowed: false; retryAfterSec: number }

function consumeAttempt(
  store: Map<string, AttemptRecord>,
  ip: string,
  config: AttemptLedgerConfig,
): AttemptDecision {
  const now = Date.now()
  const record = store.get(ip)

  if (!record) {
    setBounded(store, ip, { count: 1, firstAttemptAt: now }, LIMITER_STORE_MAX_ENTRIES)
    return { allowed: true }
  }

  const elapsed = now - record.firstAttemptAt

  // If the lockout period has passed, reset
  if (config.lockoutMs !== undefined && elapsed > config.lockoutMs) {
    setBounded(store, ip, { count: 1, firstAttemptAt: now }, LIMITER_STORE_MAX_ENTRIES)
    return { allowed: true }
  }

  // If the window has passed but lockout hasn't — at the limit means
  // still locked out (denied unconsumed); under the limit starts fresh.
  if (elapsed > config.windowMs) {
    if (config.lockoutMs !== undefined && record.count >= config.maxAttempts) {
      const retryAfterMs = record.firstAttemptAt + config.lockoutMs - now
      return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
    }
    setBounded(store, ip, { count: 1, firstAttemptAt: now }, LIMITER_STORE_MAX_ENTRIES)
    return { allowed: true }
  }

  // Within the window — at the limit means denied
  if (record.count >= config.maxAttempts) {
    const retryAfterMs = record.firstAttemptAt + (config.lockoutMs ?? config.windowMs) - now
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
  }

  record.count++
  return { allowed: true }
}

/**
 * Consume one login attempt for an IP (record-at-check — this call
 * IS the count; there is no separate record step).
 *
 * Semantics:
 *   - attempts 1–5 within the 15-min window are consumed and allowed
 *   - the 6th (any attempt at/after the limit) is denied until the
 *     30-min lockout elapses, anchored to the window's first attempt
 *   - a window that expired under the limit starts a fresh window
 *   - a lockout that fully elapsed starts a fresh window
 *
 * Denied calls do not mutate the record, so retryAfterSec always
 * counts down to the same lockout end.
 */
export function consumeLoginAttempt(ip: string): AttemptDecision {
  cleanup()
  return consumeAttempt(store, ip, { maxAttempts: MAX_ATTEMPTS, windowMs: WINDOW_MS, lockoutMs: LOCKOUT_MS })
}

/**
 * Clear rate limit for an IP (on successful login).
 * Prevents a previous failed attempt from another person
 * on the same IP from blocking the real admin.
 */
export function clearFailedAttempts(ip: string): void {
  store.delete(ip)
}

// ── OAuth flow rate limiting ────────────────────────────────────
// Prevents OAuthFlow table flooding — each GET /api/auth/twitter
// creates a DB record. Without rate limiting, an attacker can
// fill the table with expired flows.

const OAUTH_MAX_ATTEMPTS = 10
const OAUTH_WINDOW_MS = 15 * MINUTE_MS

const oauthStore = new Map<string, AttemptRecord>()
let oauthLastCleanup = Date.now()

function oauthCleanup() {
  const now = Date.now()
  if (now - oauthLastCleanup < CLEANUP_INTERVAL_MS) return
  oauthLastCleanup = now
  for (const [ip, record] of oauthStore) {
    if (now - record.firstAttemptAt > OAUTH_WINDOW_MS) {
      oauthStore.delete(ip)
    }
  }
}

/**
 * Consume one OAuth flow initiation for an IP (record-at-check — the
 * same single-call shape as consumeLoginAttempt, replacing the old
 * check/record split pair). 10 initiations per 15 min per IP.
 *
 * NO lockout branch by design: a window that expired resets even at
 * the limit — retryAfterSec on a denial counts down to the window end,
 * never beyond it.
 */
export function consumeOAuthAttempt(ip: string): AttemptDecision {
  oauthCleanup()
  return consumeAttempt(oauthStore, ip, { maxAttempts: OAUTH_MAX_ATTEMPTS, windowMs: OAUTH_WINDOW_MS })
}
