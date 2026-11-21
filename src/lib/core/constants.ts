// ============================================================
// constants.ts — Controller-wide constants
//
// Slimmed to the two values the controller actually uses; the
// instance-era constants (message limits, WIB day keys, analytics
// ranges…) live in the instance app, not here.
// ============================================================

/** App version — inlined by Next.js at build time via NEXT_PUBLIC_APP_VERSION (see next.config.ts) */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev'

/** Hard cap on in-memory rate-limiter entries (login limiter store) —
 *  bounds memory when sprayed with distinct IPs. */
export const LIMITER_STORE_MAX_ENTRIES = 10_000
