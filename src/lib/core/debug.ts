/**
 * Namespaced debug logging with timestamps.
 *
 * Set DEBUG=1 or DEBUG=* to enable all namespaces.
 * Set DEBUG=submit,posting-service to enable specific namespaces (comma-separated).
 * Unset or empty to disable (production-clean logs).
 *
 * Usage:
 *   import { debug, DEBUG_NS } from '@/lib/core/debug'
 *   debug(DEBUG_NS.SUBMIT, 'Post succeeded! tweetId:', tweetId)
 *   debug(DEBUG_NS.POSTING_SERVICE, 'Attempt', attempt, 'failed')
 */

const DEBUG_ENV = process.env.DEBUG || ''
const DEBUG_ALL = DEBUG_ENV === '1' || DEBUG_ENV === '*' || DEBUG_ENV === 'true'
// Always a Set — when DEBUG_ALL is true, isNamespaceEnabled() returns early at the
// `if (DEBUG_ALL) return true` branch, so the Set's contents are irrelevant in that case.
// Keeping it as a Set (instead of `null`) lets us drop the `?.` and `?? false` defensive
// guards in isNamespaceEnabled(), which were dead code (always-false branch).
const ENABLED_NAMESPACES = new Set(DEBUG_ENV.split(',').map(s => s.trim()).filter(Boolean))

/** The single console handle in the entire codebase.
 *  `no-console` stays fully active everywhere, including this file: the
 *  functions below are the only sanctioned emit points, so this facade owns
 *  the one reference to the platform console. Because it is the same object,
 *  anything the host or tests install on `console` (e.g. spies) still lands. */
const consoleRef = console

/** Compile-time constant for all debug namespace strings.
 *  Use DEBUG_NS.KEY instead of raw strings — the type checker catches typos.
 *  Key names are SCREAMING_SNAKE_CASE; values are the runtime namespace strings
 *  that appear in logs and the DEBUG= env var. */
export const DEBUG_NS = {
  PAIR_DICT: 'pair-dict',
  POSTING_SERVICE: 'posting-service',    // was 'direct' — renamed for clarity
  POSTING_LOCK: 'posting-lock',
  TWITTER_API: 'twitterapi',
  COOKIE_API: 'cookie-api',
  AI_FILTER: 'ai-filter',
  AI_STATUS: 'ai-status',
  AI_STATS: 'ai-stats',
  CIRCUIT_BREAKER: 'circuit-breaker',
  CIRCUIT_BREAKER_RESET: 'circuit-breaker/reset',
  CLEAR_CACHE: 'clear-cache',
  STALE_POSTING: 'stale-posting',
  DB: 'db',
  EXECUTE_POST: 'execute-post',
  SUBMIT: 'submit',
  AUTOPOST: 'autopost',
  APPROVE: 'approve',
  RETRY: 'retry',
  TEST_X: 'test-x',
  OAUTH: 'oauth',
  FILTER_SETTINGS: 'filter-settings',
  SETTINGS_VERSION: 'settings-version',
  TWITTER_AUTH: 'twitter-auth',
  SUBMISSIONS: 'submissions',
  SUBMISSIONS_MINE: 'submissions/mine',
  ADMIN_SESSION: 'admin/session',
  ADMIN_STATS: 'admin/stats',
  ADMIN_LOGIN: 'admin/login',
  ADMIN_SETTINGS: 'admin/settings',
  ANALYTICS: 'analytics',
  SUBMITTERS: 'submitters',
  SUBMITTERS_BLOCK: 'submitters/block',
  SUBMITTERS_WHITELIST: 'submitters/whitelist',
  SUBMITTERS_UNBLOCK: 'submitters/unblock',
  SUBMITTERS_OVERRIDES: 'submitters/overrides',
  AUTH_ME: 'auth/me',
  AUTH_SET_SESSION: 'auth/set-session',
  API_CLIENT: 'api-client',
  ENCRYPT: 'encrypt',
  FOLLOW_CHECK: 'follow-check',
  DB_JSONB: 'db/jsonb',
  IMAGE_SECURITY: 'image-security',
  IMAGE_STORAGE: 'image-storage',
  NSFW_SCAN: 'nsfw-scan',
  NSFW_CRON: 'nsfw-cron',
  X_MEDIA_UPLOAD: 'x-media-upload',
  LATEST_HEADERS: 'latest-headers',
  SUBMITTERS_IMAGE_POST_ALLOWLIST: 'submitters/image-post-allowlist',
  PAYMENTS: 'payments',
  PAYMENTS_GOBIZ: 'payments/gobiz',
  PAYMENTS_SWEEP: 'payments/sweep',
  POINTS: 'points',
  EGRESS: 'egress',
  KEEPALIVE: 'keepalive',
  POST_VERIFY: 'post-verify',
  TRIPWIRES: 'tripwires',
} as const

/** Union type of all valid debug namespace strings.
 *  Use this for function parameters that accept a namespace. */
export type DebugNamespace = typeof DEBUG_NS[keyof typeof DEBUG_NS]

function isNamespaceEnabled(namespace: DebugNamespace): boolean {
  if (!DEBUG_ENV) return false
  if (DEBUG_ALL) return true
  return ENABLED_NAMESPACES.has(namespace)
}

function timestamp(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

export function debug(namespace: DebugNamespace, ...args: unknown[]): void {
  if (isNamespaceEnabled(namespace)) {
    consoleRef.log(`${timestamp()} [${namespace}]`, ...args)
  }
}

export function debugError(namespace: DebugNamespace, ...args: unknown[]): void {
  if (isNamespaceEnabled(namespace)) {
    consoleRef.error(`${timestamp()} [${namespace}]`, ...args)
  }
}

/** Unconditional (no DEBUG gating) namespaced error log.
 *  Use for operational warnings that must always appear in production logs.
 *  Unlike debugError(), this always emits regardless of the DEBUG env var. */
export function logError(namespace: DebugNamespace, ...args: unknown[]): void {
  consoleRef.error(`${timestamp()} [${namespace}]`, ...args)
}

/** Unconditional (no DEBUG gating) namespaced warning log.
 *  Use for operational warnings that must always appear in production logs.
 *  Unlike debugError(), this always emits regardless of the DEBUG env var. */
export function logWarn(namespace: DebugNamespace, ...args: unknown[]): void {
  consoleRef.warn(`${timestamp()} [${namespace}]`, ...args)
}

/** Unconditional (no DEBUG gating) namespaced info log using console.log.
 *  Same as logWarn but uses console.log (info level) instead of console.warn.
 *  Use when the output must be visible in Vercel runtime logs, which
 *  only show info-level by default and filter out warn/error. */
export function logInfo(namespace: DebugNamespace, ...args: unknown[]): void {
  consoleRef.log(`${timestamp()} [${namespace}]`, ...args)
}
