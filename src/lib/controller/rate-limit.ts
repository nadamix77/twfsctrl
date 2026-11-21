// ============================================================
// rate-limit.ts — Controller login rate limiter (FR-A3)
//
// Mirrors the instance scheme exactly (5 failed attempts / 15 min /
// IP → 30-min lockout with 429 + Retry-After) but with its OWN
// ledger, decoupled from the instance app's login limiter — the
// two surfaces must never lock each other out.
// Record-at-check semantics copied from src/lib/auth/login-rate-limit.ts.
// ============================================================

interface AttemptRecord {
  count: number
  firstAttemptAt: number // epoch ms
}

const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60_000
const LOCKOUT_MS = 30 * 60_000

const store = new Map<string, AttemptRecord>()

let lastCleanup = Date.now()
const CLEANUP_INTERVAL_MS = 10 * 60_000

function cleanup() {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  for (const [ip, record] of store) {
    if (now - record.firstAttemptAt > LOCKOUT_MS) store.delete(ip)
  }
}

export type LoginAttemptDecision = { allowed: true } | { allowed: false; retryAfterSec: number }

/** Consume one controller-login attempt for an IP (record-at-check). */
export function consumeControllerLoginAttempt(ip: string): LoginAttemptDecision {
  cleanup()
  const now = Date.now()
  const record = store.get(ip)

  if (!record) {
    if (store.size > 10_000) store.clear()
    store.set(ip, { count: 1, firstAttemptAt: now })
    return { allowed: true }
  }

  const elapsed = now - record.firstAttemptAt

  if (elapsed > LOCKOUT_MS) {
    store.set(ip, { count: 1, firstAttemptAt: now })
    return { allowed: true }
  }

  if (elapsed > WINDOW_MS) {
    if (record.count >= MAX_ATTEMPTS) {
      return { allowed: false, retryAfterSec: Math.ceil((record.firstAttemptAt + LOCKOUT_MS - now) / 1000) }
    }
    store.set(ip, { count: 1, firstAttemptAt: now })
    return { allowed: true }
  }

  if (record.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSec: Math.ceil((record.firstAttemptAt + LOCKOUT_MS - now) / 1000) }
  }

  record.count++
  return { allowed: true }
}

/** Clear the ledger on successful login (a later legit attempt by the
 *  same IP must not inherit earlier failures). */
export function clearControllerLoginAttempts(ip: string): void {
  store.delete(ip)
}
