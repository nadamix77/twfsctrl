// ============================================================
// time-constants.ts — Named time duration constants
//
// Replaces inline magic numbers (30_000, 15_000, etc.)
// with self-documenting named constants.
// ============================================================

export const SECOND_MS = 1_000
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Seconds-based constants — for TTL values expressed in seconds (cookies, tokens, etc.) */
export const MINUTE_S = 60
// Test seam: consumed only by src/__tests__/**
export const HOUR_S = 3_600
export const DAY_S = 86_400

/** Default timeout for quick API/health-check requests — 5 seconds */
export const FETCH_TIMEOUT_SHORT_MS = 5 * SECOND_MS

/** Default timeout for standard API requests (credits, transaction ID, follow check) — 10 seconds */
export const FETCH_TIMEOUT_MS = 10 * SECOND_MS

/** Default timeout for Twitter API requests (auth, login, media upload, posting) — 15 seconds */
export const FETCH_TIMEOUT_LONG_MS = 15 * SECOND_MS

/** Timeout for large uploads (media INIT/FINALIZE) and long-running API calls — 30 seconds */
export const FETCH_TIMEOUT_UPLOAD_MS = 30 * SECOND_MS

/** Browser → app API read timeout (GET) — 15 seconds. Every GET route's
 *  maxDuration (30s) sits above it, so a healthy route never trips it. */
export const CLIENT_READ_TIMEOUT_MS = 15 * SECOND_MS

/** Browser → app API mutation timeout (POST/PATCH/DELETE) — 60 seconds,
 *  matching the ceiling of every route's declared maxDuration (the awaited
 *  posting pipeline at /api/submissions). Never cuts a legal request short. */
export const CLIENT_MUTATION_TIMEOUT_MS = 60 * SECOND_MS
