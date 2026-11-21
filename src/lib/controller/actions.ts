// ============================================================
// actions.ts — Queue actions + instance quick actions (Epics D/E)
//
// Thin translation table: controller action → instance HTTP call.
// The instance's JSON body is passed through VERBATIM (C4) — the
// controller adds no copy of its own on the success path.
// ============================================================

import { callInstance } from './instance-client'
import type { ResolvedInstance } from './registry'
import type { InstanceQuickAction, QueueAction, QueueActionResponse, QuickActionResponse } from './types'

function actionError(call: { ok: false; error: string; status: number }): QueueActionResponse & QuickActionResponse {
  return { ok: false, status: call.status, body: null, error: call.error }
}

/** Execute one moderation action against one instance submission.
 *  Never throws; returns the raw instance status + body. */
export async function performQueueAction(
  instance: ResolvedInstance,
  submissionId: string,
  action: QueueAction,
): Promise<QueueActionResponse> {
  const target = { key: instance.id, baseUrl: instance.baseUrl, password: instance.password ?? '' }
  const id = encodeURIComponent(submissionId)

  let call: Awaited<ReturnType<typeof callInstance>>
  switch (action) {
    case 'approve':
      call = await callInstance(target, `/api/submissions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      })
      break
    case 'reject':
      call = await callInstance(target, `/api/submissions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      })
      break
    case 'retry':
      call = await callInstance(target, `/api/submissions/${id}/post`, { method: 'POST' })
      break
    case 'refund':
      call = await callInstance(target, `/api/submissions/${id}/refund`, { method: 'POST' })
      break
    case 'delete':
      call = await callInstance(target, `/api/submissions/${id}`, { method: 'DELETE' })
      break
    default:
      return { ok: false, status: 0, body: null, error: 'Aksi tidak dikenal' }
  }

  if (!call.ok) return actionError(call)

  const errorBody = call.body as { error?: unknown } | null
  const errorText =
    call.status >= 400 && typeof errorBody?.error === 'string' && errorBody.error ? errorBody.error : null

  return { ok: call.status >= 200 && call.status < 300, status: call.status, body: call.body, error: errorText }
}

// Map (not Record) avoids the "Generic Object Injection Sink" SAST warning
// (same pattern as the instance submissions route).
const QUICK_ACTION_PATHS = new Map<InstanceQuickAction, string>([
  ['requeue', '/api/admin/submissions/requeue'],
  ['breaker-reset', '/api/admin/circuit-breaker/reset'],
  ['clear-cache', '/api/admin/clear-cache'],
])

/** Execute one instance quick action (FR-E1). */
export async function performQuickAction(
  instance: ResolvedInstance,
  action: InstanceQuickAction,
): Promise<QuickActionResponse> {
  const path = QUICK_ACTION_PATHS.get(action)
  if (!path) return { ok: false, status: 0, body: null, error: 'Aksi tidak dikenal' }

  const call = await callInstance(
    { key: instance.id, baseUrl: instance.baseUrl, password: instance.password ?? '' },
    path,
    { method: 'POST' },
  )
  if (!call.ok) return actionError(call)

  const errorBody = call.body as { error?: unknown } | null
  const errorText =
    call.status >= 400 && typeof errorBody?.error === 'string' && errorBody.error ? errorBody.error : null

  return { ok: call.status >= 200 && call.status < 300, status: call.status, body: call.body, error: errorText }
}
