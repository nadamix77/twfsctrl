// ============================================================
// origin-guard.ts — OWASP same-origin verification for state-changing
// POST endpoints
//
// Per the OWASP CSRF Prevention Cheat Sheet: validate Origin if
// present, else validate Referer, else block. Cross-site POST fetches
// and cross-site form submissions always carry an Origin header, so a
// mismatch (or a missing header pair) means the request did not come
// from this site's own pages.
//
// Scope: ONLY same-origin fetch/form POSTs (set-session, admin-login,
// auth/logout, admin/logout). Top-level GET navigations (the OAuth start
// route) carry no Origin and
// may carry no Referer (privacy extensions / no-referrer policies) —
// never apply this guard to them. X-side callback landing points are
// cross-site by design and are likewise out of scope.
//
// The accept predicate is an OR over three host authorities (a future
// refactor must not tighten it to an AND — the OR-semantics pin in
// origin-guard.test.ts documents why):
//   A. the request Host header — direct access and faithful-Host
//      production edges (Vercel);
//   B. X-Forwarded-Host — proxies that strip the port from Host but
//      preserve the original host:port here. The OWASP condition for
//      trusting it holds on this deployment: the gateway overwrites
//      any client-supplied value (proven by a live spoof probe), and
//      browser cross-origin fetches carrying custom headers die in a
//      CORS preflight these endpoints never approve;
//   C. TRUSTED_ORIGINS — comma-separated full origins (scheme
//      required; Django CSRF_TRUSTED_ORIGINS semantics) for proxy
//      chains that rewrite Host entirely and leave no faithful host
//      header at the app (e.g. a Function-Compute edge swapping Host
//      for an internal hostname). Unset/empty → no C verdicts.
// With no forwarded header and no env configured, every decision is
// byte-identical to the Host-only comparison (the degenerate-case pin).
//
// Message quirk kept verbatim from the original inline set-session
// guard: a REFERER mismatch reports 'Origin tidak valid' (not 'Referer
// tidak valid') — only an unparseable Referer reports 'Referer tidak valid'.
// ============================================================

import type { NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'

/**
 * The first (client-visible) entry of a comma-chained X-Forwarded-Host,
 * trimmed; null when the header is absent, blank, or has no usable
 * first entry. Chained proxies append entries, so the first is the
 * original client-visible host. Trust condition: only the gateway can
 * set this header here — it overwrites client-supplied values (see the
 * file header, branch B).
 */
function firstForwardedHost(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-host')
  if (!forwarded) return null
  // First comma entry = the client-visible host (chained proxies
  // append); a blank entry means no usable forwarded host.
  const commaIndex = forwarded.indexOf(',')
  const first = (commaIndex === -1 ? forwarded : forwarded.slice(0, commaIndex)).trim()
  return first || null
}

/**
 * TRUSTED_ORIGINS → this deployment's own origins, as URL.origin
 * strings (scheme + host + port, default ports normalized away).
 * Comma-separated full origins with scheme — Django
 * CSRF_TRUSTED_ORIGINS semantics; configure it only on proxy chains
 * that rewrite Host and X-Forwarded-Host beyond recognition.
 * Malformed entries are skipped (the allowlist is operator config,
 * not client input); unset or empty env → no entries. Read per call,
 * the same per-request pattern as ADMIN_PASSWORD.
 */
function parseTrustedOrigins(): string[] {
  const raw = process.env.TRUSTED_ORIGINS
  if (!raw) return []
  const origins: string[] = []
  for (const entry of raw.split(',')) {
    const candidate = entry.trim()
    if (!candidate) continue
    try {
      const origin = new URL(candidate).origin
      // 'null' = parsed but not a full origin (a bare 'host:port' or
      // opaque-path URL) — never a trustable origin.
      if (origin !== 'null') origins.push(origin)
    } catch {
      // Malformed entry — skip; the allowlist is config, not input.
      continue
    }
  }
  return origins
}

/**
 * Verify the request Origin (or Referer fallback) is one of this
 * deployment's own origins — CSRF protection for cookie-mutating POST
 * endpoints. See the file header for the three-branch predicate and
 * each branch's topology.
 *
 * @param req The incoming request
 * @returns null when same-origin (the caller proceeds), or the 400/403
 *          rejection response to return immediately
 */
export function verifySameOrigin(req: NextRequest): NextResponse | null {
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')
  const requestHost = req.headers.get('host')
  if (!requestHost) {
    return clientErrorResponse('Header Host tidak ditemukan', 400)
  }

  let sourceUrl: URL | null = null
  if (origin) {
    try { sourceUrl = new URL(origin) } catch { return clientErrorResponse('Origin tidak valid', 403) }
  } else if (referer) {
    try { sourceUrl = new URL(referer) } catch { return clientErrorResponse('Referer tidak valid', 403) }
  }
  if (sourceUrl === null) {
    return clientErrorResponse('Header Origin/Referer tidak ditemukan', 403)
  }

  const forwardedHost = firstForwardedHost(req.headers)
  const sameOrigin =
    sourceUrl.host === requestHost
    || (forwardedHost !== null && sourceUrl.host === forwardedHost)
    || parseTrustedOrigins().includes(sourceUrl.origin)
  if (!sameOrigin) {
    return clientErrorResponse('Origin tidak valid', 403)
  }

  return null
}
