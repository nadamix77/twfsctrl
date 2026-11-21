import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse, parseJsonBody, rateLimitResponse } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { verifySameOrigin } from '@/lib/core/origin-guard'
import {
  CONTROLLER_COOKIE_NAME,
  CONTROLLER_TOKEN_TTL,
  controllerCookieOptions,
  controllerPasswordMatches,
  generateControllerToken,
} from '@/lib/controller/auth'
import { getControllerSessionSecret, isControllerAuthConfigured } from '@/lib/controller/config'
import { clearControllerLoginAttempts, consumeControllerLoginAttempt } from '@/lib/controller/rate-limit'
import { recordAudit } from '@/lib/controller/audit'
import { controllerError } from '@/lib/controller/log'

// POST /api/controller/login — Controller operator login (FR-A1–A3)
//
// Mirrors the instance admin login route with controller-scoped secrets
// (src/app/api/admin/login/route.ts — the two surfaces share the posture
// but never the credential material):
//   1. CSRF-guarded (verifySameOrigin) BEFORE the limiter: a forged
//      cross-site POST is rejected before it can burn the victim IP's
//      attempt ledger.
//   2. Rate-limited 5 attempts / 15 min / IP → 30-min lockout with
//      429 + Retry-After (own ledger, decoupled from the instance app).
//      Record-at-check semantics: every attempt shape consumes, including
//      malformed bodies; success clears the ledger.
//   3. 503 with a setup hint when the controller env is not configured
//      (the panel still boots so the operator sees the instruction).
//
// On success issues an HMAC token (7-day TTL) in the HttpOnly,
// SameSite=Strict `controller_token` cookie. Audit-logged both ways.
const NOT_CONFIGURED_ERROR =
  'Controller belum dikonfigurasi. Set ADMIN_PASSWORD dan SESSION_SECRET di environment.'

export async function POST(req: NextRequest) {
  try {
    // --- Origin guard (before the limiter consume — see above) ---
    const originRejection = verifySameOrigin(req)
    if (originRejection) return originRejection

    // --- Rate limit (record-at-check: this call IS the count) ---
    const ip = getClientIp(req.headers)
    const attempt = consumeControllerLoginAttempt(ip)
    if (!attempt.allowed) {
      return rateLimitResponse(
        'Terlalu banyak percobaan login. Coba lagi nanti.',
        attempt.retryAfterSec,
        { bodyRetryAfterSec: true },
      )
    }

    if (!isControllerAuthConfigured()) {
      return NextResponse.json({ error: NOT_CONFIGURED_ERROR }, { status: 503 })
    }

    const parsed = await parseJsonBody<{ password?: unknown }>(req)
    if (!parsed.ok) return parsed.response
    const { password } = parsed.body
    if (typeof password !== 'string' || password.length === 0) {
      return clientErrorResponse('Password salah', 401)
    }

    // Timing-safe comparison (auth.ts) — no early exit on length.
    if (!controllerPasswordMatches(password)) {
      await recordAudit({ action: 'controller.login', outcome: 'error', detail: 'password salah', actorIp: ip })
      return clientErrorResponse('Password salah', 401)
    }

    clearControllerLoginAttempts(ip)
    const secret = getControllerSessionSecret()
    if (!secret) {
      // Defensive: isControllerAuthConfigured() already passed, so this is
      // an env race at worst — answer with the same setup hint, never 500.
      return NextResponse.json({ error: NOT_CONFIGURED_ERROR }, { status: 503 })
    }

    const response = NextResponse.json({ success: true })
    response.cookies.set(
      CONTROLLER_COOKIE_NAME,
      generateControllerToken(secret),
      controllerCookieOptions(CONTROLLER_TOKEN_TTL),
    )
    await recordAudit({ action: 'controller.login', outcome: 'success', actorIp: ip })
    return response
  } catch (e) {
    controllerError('login error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Terjadi kesalahan server. Coba lagi nanti.' }, { status: 500 })
  }
}
