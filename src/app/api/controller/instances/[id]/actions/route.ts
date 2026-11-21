import { NextResponse } from 'next/server'
import { clientErrorResponse, parseJsonBody } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { performQuickAction } from '@/lib/controller/actions'
import { recordAudit } from '@/lib/controller/audit'
import type { InstanceQuickAction, QuickActionResponse } from '@/lib/controller/types'

// POST /api/controller/instances/[id]/actions — instance quick actions
// (FR-E1 / FR-D9)
//
// One endpoint, whitelisted action verbs: `requeue` (bulk requeue
// post_failed), `breaker-reset` (circuit breaker), `clear-cache`.
// The instance's status/body envelope passes through VERBATIM as HTTP 200
// (QuickActionResponse) so the client toasts the instance's own
// success/error message (FR-E2) — the controller adds no copy of its own.
// Audit detail carries the requeued count or the instance message, never
// submission content (FR-F2).
//
// Instance round-trips can take up to ~16s worst case (call + re-login),
// hence the raised function timeout.
export const maxDuration = 30

type RouteContext = { params: Promise<{ id: string }> }

/** Whitelist parse — literal comparisons only, no dynamic dispatch. */
function parseQuickAction(value: unknown): InstanceQuickAction | null {
  if (value === 'requeue' || value === 'breaker-reset' || value === 'clear-cache') return value
  return null
}

/** Audit detail: the requeued count for requeue, the instance's own
 *  message otherwise, its error text on failure — never submission
 *  content (FR-F2). */
function quickActionDetail(action: InstanceQuickAction, result: QuickActionResponse): string | null {
  if (!result.ok) return result.error
  const body = result.body as { requeued?: unknown; message?: unknown } | null
  if (action === 'requeue') {
    return typeof body?.requeued === 'number' ? `requeued: ${body.requeued}` : null
  }
  return typeof body?.message === 'string' && body.message.length > 0 ? body.message : null
}

export const POST = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { id } = await params

  const parsed = await parseJsonBody<{ action?: unknown }>(req)
  if (!parsed.ok) return parsed.response

  const action = parseQuickAction(parsed.body.action)
  if (action === null) return clientErrorResponse('Aksi tidak dikenal')

  const instance = await getResolvedInstance(id)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const result = await performQuickAction(instance, action)

  const detail = quickActionDetail(action, result)
  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: `instance.${action}`,
    outcome: result.ok ? 'success' : 'error',
    ...(detail !== null ? { detail } : {}),
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})
