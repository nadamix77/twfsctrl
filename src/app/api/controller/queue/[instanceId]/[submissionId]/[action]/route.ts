import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { performQueueAction } from '@/lib/controller/actions'
import { recordAudit } from '@/lib/controller/audit'
import type { QueueAction, QueueActionResponse } from '@/lib/controller/types'

// POST /api/controller/queue/[instanceId]/[submissionId]/[action] —
// moderation actions on one instance submission (FR-D4–D8)
//
// Whitelisted verbs: approve | reject | retry | refund | delete. The
// instance's status + JSON body envelope passes through VERBATIM as
// HTTP 200 (QueueActionResponse) so the client renders instance copy
// exactly — 409 CAS conflicts, 503 breaker deferrals and the rest keep
// their own status INSIDE the envelope for the client to branch on.
// Params arrive URL-decoded; performQueueAction re-encodes the id for
// the upstream path.
//
// Audit detail records the instance's outcome `kind` (auto-posted /
// queued / error / …) or the error string — never message content (FR-F2).
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string; submissionId: string; action: string }> }

/** Whitelist parse — literal comparisons only, no dynamic dispatch. */
function parseQueueAction(value: string): QueueAction | null {
  if (value === 'approve' || value === 'reject' || value === 'retry' || value === 'refund' || value === 'delete') {
    return value
  }
  return null
}

/** Audit detail: the instance's outcome `kind` on success, its error
 *  string on failure — never submission content (FR-F2). */
function queueActionDetail(result: QueueActionResponse): string | null {
  if (!result.ok) return result.error
  const kind = (result.body as { kind?: unknown } | null)?.kind
  return typeof kind === 'string' && kind.length > 0 ? kind : null
}

export const POST = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { instanceId, submissionId, action: rawAction } = await params

  const action = parseQueueAction(rawAction)
  if (action === null) return clientErrorResponse('Aksi tidak dikenal')

  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const result = await performQueueAction(instance, submissionId, action)

  const detail = queueActionDetail(result)
  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: `submission.${action}`,
    targetId: submissionId,
    outcome: result.ok ? 'success' : 'error',
    ...(detail !== null ? { detail } : {}),
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})
