import { type NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { verifySameOrigin } from '@/lib/core/origin-guard'
import {
  CONTROLLER_COOKIE_NAME,
  controllerCookieOptions,
  getControllerTokenFromRequest,
  verifyControllerToken,
} from '@/lib/controller/auth'
import { recordAudit } from '@/lib/controller/audit'

// POST /api/controller/logout — Clear the controller session cookie (FR-A5)
//
// Intentionally NOT wrapped in withControllerAuth: a logout must work with
// an expired/invalid token — the sole purpose is clearing the
// `controller_token` cookie, and blocking on auth would create an
// irreversible lockout (the operator could neither log out nor see a sane
// session state without hand-clearing cookies in DevTools).
//
// CSRF-guarded (verifySameOrigin) like the instance logout routes — a
// forged cross-site POST must not be able to force-clear the operator's
// session cookie (logout-CSRF: a nuisance session-clearing DoS). The
// cookie's SameSite=Strict does not help here: the forged request needs
// no cookie SENT, the response Set-Cookie applies regardless.
export async function POST(req: NextRequest) {
  const originRejection = verifySameOrigin(req)
  if (originRejection) return originRejection

  const response = NextResponse.json({ success: true })
  response.cookies.set(CONTROLLER_COOKIE_NAME, '', controllerCookieOptions(0))

  // Audit only when the session was still valid — an expired-token logout
  // clears the cookie just the same but is not an operator action.
  if (verifyControllerToken(getControllerTokenFromRequest(req)).authorized) {
    await recordAudit({ action: 'controller.logout', outcome: 'success', actorIp: getClientIp(req.headers) })
  }
  return response
}
