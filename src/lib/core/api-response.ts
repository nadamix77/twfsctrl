// ============================================================
// api-response.ts — Consistent API response helpers
//
// Centralizes the shape of API responses so every route
// produces the same `{ error: string }` JSON body for errors.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { getErrorMessage } from '@/lib/core/utils'
import { logError, type DebugNamespace } from '@/lib/core/debug'

/**
 * Create a pure `{ error: string }` JSON response for any status.
 *
 * Use this instead of ad-hoc `NextResponse.json({ error: ... }, { status })`
 * so every route produces the same error-body shape. Not limited to 4xx:
 * a known-condition failure that carries no server-side detail may pass 500
 * (precedent: the submissions image-failure site) — for 5xx errors with a
 * raw error object to log, prefer `serverErrorResponse()` instead.
 *
 * @param message  Human-readable error description
 * @param status   HTTP status code (default 400)
 */
export function clientErrorResponse(message: string, status: number = 400): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/**
 * Create a 429 Too Many Requests JSON response with a Retry-After header.
 *
 * Use this for per-IP limiter denials so the status, header, and body stay
 * identical across routes. Mirrors serviceUnavailableResponse's header
 * convention (RFC 7231), at 429.
 *
 * @param message        Human-readable error description (body's `error` field)
 * @param retryAfterSec  Suggested retry delay in seconds — always sent as the
 *                       Retry-After header
 * @param opts.bodyRetryAfterSec  Also mirror the delay into the JSON body
 *                       (the login/OAuth 429 body shape — a machine-readable
 *                       mirror alongside the header)
 */
export function rateLimitResponse(
  message: string,
  retryAfterSec: number,
  opts?: { bodyRetryAfterSec?: boolean },
): NextResponse {
  return NextResponse.json(
    opts?.bodyRetryAfterSec ? { error: message, retryAfterSec } : { error: message },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}

/**
 * Create a server-error JSON response.
 *
 * Use this for 5xx errors that aren't already covered by `ApiError.toResponse()`.
 *
 * @param message  Human-readable error description
 * @param status   HTTP status code (default 500)
 */
export function serverErrorResponse(debugNs: DebugNamespace, label: string, error: unknown, status: number = 500): NextResponse {
  // Log full details server-side only (label + raw error for debugging)
  logError(debugNs, label, error)
  // Return generic Indonesian message to client — no English labels, no raw errors
  return NextResponse.json({ error: 'Terjadi kesalahan server. Coba lagi nanti.' }, { status })
}

/**
 * Create a cron-error JSON response with Cache-Control: no-store.
 *
 * Used by cron endpoints (autopost, nsfw-scan) for error responses
 * that must not be cached by CDNs/proxies.
 *
 * @param debugNs  Debug namespace (for caller consistency with serverErrorResponse)
 * @param label    Human-readable error label
 * @param error    The error value
 * @param status   HTTP status code (default 500)
 */
export function cronErrorResponse(debugNs: DebugNamespace, label: string, error: unknown, status: number = 500): NextResponse {
  logError(debugNs, label, error)
  const message = getErrorMessage(error, String(error))
  return NextResponse.json({ error: `${label} ${message}` }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Create a 503 Service Unavailable response with optional Retry-After header.
 *
 * Use this when the server cannot handle the request due to a temporary
 * condition (e.g. circuit breaker active, X API down). The Retry-After
 * header tells clients when to try again (RFC 7231).
 *
 * @param message       Human-readable error description
 * @param retryAfterSec Suggested retry delay in seconds (optional)
 */
export function serviceUnavailableResponse(message: string, retryAfterSec?: number): NextResponse {
  const init: ResponseInit = { status: 503 }
  if (retryAfterSec != null) {
    init.headers = { 'Retry-After': String(retryAfterSec) }
  }
  return NextResponse.json({ error: message }, init)
}

/** The fail-closed busy copy — the step-1/step-3 submission gates and
 *  the auth/me gate share it verbatim. (The 429 title 'Sistem sedang
 *  sibuk' in _rate-limits.ts is a different, shorter string on purpose.) */
export const SYSTEM_BUSY_MESSAGE = 'Sistem sedang sibuk. Coba lagi beberapa saat.'

/**
 * Parse JSON body with consistent error handling.
 *
 * Returns the parsed body or a clientErrorResponse (HTTP 400) on malformed JSON.
 * Malformed JSON is a client error (400), not a server error (500).
 *
 * Usage:
 *   const parsed = await parseJsonBody<{ status?: string }>(req)
 *   if (!parsed.ok) return parsed.response
 *   const { status } = parsed.body
 */
export async function parseJsonBody<T = unknown>(
  req: NextRequest | Request,
): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  try {
    const body = await req.json() as T
    return { ok: true, body }
  } catch {
    return { ok: false, response: clientErrorResponse('Request body tidak valid') }
  }
}
