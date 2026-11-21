import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse, parseJsonBody } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { validateInstanceBaseUrl } from '@/lib/controller/instance-url'
import { probeSessionPending, testInstanceConnection } from '@/lib/controller/instance-client'
import { recordAudit } from '@/lib/controller/audit'
import type { ConnectionTestResult } from '@/lib/controller/types'

// POST /api/controller/instances/test — Connectivity test (FR-B2)
//
// Login + session probe against an arbitrary (not-yet-saved) base URL so
// the add/edit form can report success/failure BEFORE the operator saves.
// The outcome envelope always answers HTTP 200 — the ConnectionTestResult
// body carries the verdict; only URL-validation failures are 400.
// Failure text is the INSTANCE's own error verbatim (e.g. 'Password
// salah') per the pass-through rule (C4) — the controller adds no copy of
// its own on top of what the instance already says.
//
// The probe rides the `test:<baseUrl>` token cache key, so the pending
// count costs no second login.
export const maxDuration = 30

export const POST = withControllerAuth(async (req: NextRequest) => {
  const parsed = await parseJsonBody<{ baseUrl?: unknown; adminPassword?: unknown }>(req)
  if (!parsed.ok) return parsed.response
  const { baseUrl, adminPassword } = parsed.body

  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return clientErrorResponse('URL wajib diisi')
  }
  if (typeof adminPassword !== 'string' || adminPassword.length === 0) {
    return clientErrorResponse('Password admin instance wajib diisi')
  }

  const url = await validateInstanceBaseUrl(baseUrl)
  if (!url.ok) return clientErrorResponse(url.error)

  const outcome = await testInstanceConnection(url.url, adminPassword)

  let result: ConnectionTestResult
  if (outcome.ok) {
    const pending = await probeSessionPending({ key: `test:${url.url}`, baseUrl: url.url, password: adminPassword })
    result = {
      ok: true,
      status: 200,
      message: 'Terhubung',
      ...(pending !== null ? { pending } : {}),
    }
  } else if (outcome.kind === 'locked-out') {
    result = {
      ok: false,
      status: 429,
      message: outcome.error,
      ...(outcome.retryAfterSec !== null ? { retryAfterSec: outcome.retryAfterSec } : {}),
    }
  } else {
    // 'auth-failed' (instance text verbatim) and 'down' (timeout/DNS/5xx)
    // share the shape; the instance's status passes through as-is.
    result = { ok: false, status: outcome.status, message: outcome.error }
  }

  await recordAudit({
    action: 'instance.test',
    outcome: result.ok ? 'success' : 'error',
    detail: result.message,
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})
