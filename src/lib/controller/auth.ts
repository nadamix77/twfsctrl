// ============================================================
// auth.ts — Controller session auth (Epic A, PRD FR-A1/A2/A4/A5)
//
// Copies the instance app's ADR-002 design with controller-scoped
// secrets and cookie name, so instance admin tokens and controller
// tokens can never cross-verify:
//   token   = HMAC-SHA256(SESSION_SECRET,
//                          "tweetfess-controller:admin:v1:<expiresAt>")
//   format  = <hmac_hex>.<expiresAt_hex>     (7-day TTL)
//   cookie  = controller_token (HttpOnly, SameSite=Strict)
//   header  = Authorization: Bearer <token>  (curl parity)
// ============================================================

import crypto from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { DAY_S } from '@/lib/core/time-constants'
import { timingSafeEqual } from '@/lib/core/crypto-utils'
import { getControllerAdminPassword, getControllerSessionSecret, isControllerAuthConfigured } from './config'
import { controllerError } from './log'

const CONTROLLER_TOKEN_LABEL = 'tweetfess-controller:admin:v1'
export const CONTROLLER_TOKEN_TTL = 7 * DAY_S
export const CONTROLLER_COOKIE_NAME = 'controller_token'

function unauthenticatedResponse(): NextResponse {
  return NextResponse.json({ error: 'Tidak terautentikasi' }, { status: 401 })
}

/** Extract controller token — cookie first (browser), Bearer header second (curl). */
export function getControllerTokenFromRequest(req: NextRequest): string | null {
  const cookieToken = req.cookies.get(CONTROLLER_COOKIE_NAME)?.value
  if (cookieToken) return cookieToken
  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return null
}

function deriveControllerToken(secret: string, expiresAt: number): string {
  return crypto.createHmac('sha256', secret).update(`${CONTROLLER_TOKEN_LABEL}:${expiresAt}`).digest('hex')
}

/** Generate a controller token with embedded expiry (hex suffix). */
export function generateControllerToken(secret: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + CONTROLLER_TOKEN_TTL
  const hmac = deriveControllerToken(secret, expiresAt)
  return `${hmac}.${expiresAt.toString(16)}`
}

/** Timing-safe verify against the controller secrets.
 *  Distinct 401 copy for expiry mirrors the instance app. */
export function verifyControllerToken(token: string | null):
  | { authorized: true }
  | { authorized: false; response: NextResponse } {
  if (!isControllerAuthConfigured()) {
    return {
      authorized: false,
      response: NextResponse.json(
        { error: 'Controller belum dikonfigurasi. Set ADMIN_PASSWORD dan SESSION_SECRET.' },
        { status: 503 },
      ),
    }
  }
  const secret = getControllerSessionSecret() as string

  if (!token) return { authorized: false, response: unauthenticatedResponse() }

  const submitted = token.startsWith('Bearer ') ? token.slice(7) : token
  const dotIndex = submitted.lastIndexOf('.')
  if (dotIndex === -1) return { authorized: false, response: unauthenticatedResponse() }

  const submittedHmac = submitted.slice(0, dotIndex)
  const expiresAt = parseInt(submitted.slice(dotIndex + 1), 16)
  if (isNaN(expiresAt)) return { authorized: false, response: unauthenticatedResponse() }

  if (Math.floor(Date.now() / 1000) > expiresAt) {
    return { authorized: false, response: NextResponse.json({ error: 'Sesi telah berakhir' }, { status: 401 }) }
  }

  if (!timingSafeEqual(submittedHmac, deriveControllerToken(secret, expiresAt))) {
    return { authorized: false, response: unauthenticatedResponse() }
  }
  return { authorized: true }
}

/** Cookie options for the controller session cookie (Strict CSRF posture). */
export function controllerCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge,
    path: '/',
  }
}

/** Route-handler wrapper enforcing controller auth on every
 *  /api/controller/* route except login/logout/session semantics.
 *  Mirrors withAdmin() (ADR-007 two-layer belt). */
export function withControllerAuth<C = unknown>(
  handler: (req: NextRequest, ctx: C) => Promise<NextResponse>,
): (req: NextRequest, ctx: C) => Promise<NextResponse> {
  return async (req, ctx) => {
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID()
    const auth = verifyControllerToken(getControllerTokenFromRequest(req))
    if (!auth.authorized) {
      auth.response.headers.set('x-request-id', requestId)
      // Clear the cookie on failure — mirrors proxy.ts behavior so an
      // expired token never sticks around when the proxy is bypassed.
      auth.response.cookies.set(CONTROLLER_COOKIE_NAME, '', controllerCookieOptions(0))
      return auth.response
    }
    try {
      const result = await handler(req, ctx)
      result.headers.set('x-request-id', requestId)
      return result
    } catch (e) {
      controllerError('unexpected route error:', e instanceof Error ? e.message : e)
      const response = NextResponse.json({ error: 'Terjadi kesalahan server. Coba lagi nanti.' }, { status: 500 })
      response.headers.set('x-request-id', requestId)
      return response
    }
  }
}

/** Timing-safe password comparison for the login route (FR-A1). */
export function controllerPasswordMatches(submitted: string): boolean {
  const actual = getControllerAdminPassword()
  if (!actual) return false
  return timingSafeEqual(submitted, actual)
}
