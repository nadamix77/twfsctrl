import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { performPaymentAction, type PaymentActionPayload } from '@/lib/controller/payments'
import { recordAudit } from '@/lib/controller/audit'
import type { PaymentAction, QuickActionResponse } from '@/lib/controller/types'

// POST /api/controller/payments/[instanceId]/[action] — payment repair
// actions on one instance:
//
//   confirm { orderId, note, refId? }  manual confirm (NOT a payment
//                                       channel — money must have arrived)
//   void    { orderId }                early-expire a pending order
//   dismiss { refId }                  dismiss an ambiguous-credit hold
//
// The instance's status + JSON envelope passes through VERBATIM.
// Audit targetId = order id (confirm/void) or refId (dismiss); the
// confirm NOTE never enters the audit trail (FR-F2 — the instance's
// own order row is the audit carrier for it).
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string; action: string }> }

const NOTE_MAX = 300
const REFID_MAX = 100
const ORDERID_MAX = 100

function parseAction(value: string): PaymentAction | null {
  if (value === 'confirm' || value === 'void' || value === 'dismiss') return value
  return null
}

function parsePayload(
  action: PaymentAction,
  body: Record<string, unknown> | null,
): { ok: true; orderId?: string; note?: string | null; refId?: string | null; dismissRefId?: string } | { ok: false; error: string } {
  if (body == null) return { ok: false, error: 'Body permintaan tidak valid' }

  if (action === 'dismiss') {
    const refId = typeof body.refId === 'string' ? body.refId.trim() : ''
    if (refId.length === 0 || refId.length > REFID_MAX) return { ok: false, error: 'refId wajib diisi' }
    return { ok: true, dismissRefId: refId }
  }

  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : ''
  if (orderId.length === 0 || orderId.length > ORDERID_MAX) {
    return { ok: false, error: 'ID order wajib diisi' }
  }

  if (action === 'void') return { ok: true, orderId }

  // confirm
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (note.length === 0 || note.length > NOTE_MAX) {
    return { ok: false, error: `Catatan wajib diisi (maksimal ${NOTE_MAX} karakter)` }
  }
  let refId: string | null = null
  if (body.refId != null && typeof body.refId === 'string' && body.refId.trim().length > 0) {
    refId = body.refId.trim()
    if (refId.length > REFID_MAX) return { ok: false, error: 'refId tidak valid' }
  }
  return { ok: true, orderId, note, refId }
}

/** Audit detail: the instance outcome flags — never the note text (FR-F2). */
function actionDetail(result: QuickActionResponse): string | null {
  if (!result.ok) return result.error
  const b = result.body as Record<string, unknown> | null
  if (b == null || typeof b !== 'object') return null
  const parts: string[] = []
  if (b.latePayment === true) parts.push('late-payment')
  if (b.overBalance === true) parts.push('over-balance')
  return parts.length > 0 ? parts.join(',') : null
}

export const POST = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { instanceId, action: rawAction } = await params

  const action = parseAction(rawAction)
  if (action === null) return clientErrorResponse('Aksi tidak dikenal')

  let body: Record<string, unknown> | null = null
  try {
    const parsed = await req.json()
    body = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    body = null
  }

  const parsed = parsePayload(action, body)
  if (!parsed.ok) return clientErrorResponse(parsed.error)

  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  // exactOptionalPropertyTypes: only carry the fields the action needs.
  const payload: PaymentActionPayload =
    action === 'dismiss'
      ? { dismissRefId: parsed.dismissRefId }
      : action === 'void'
        ? { orderId: parsed.orderId }
        : { orderId: parsed.orderId, note: parsed.note ?? '', refId: parsed.refId ?? '' }

  const result = await performPaymentAction(instance, action, payload)

  const detail = actionDetail(result)
  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: `payment.${action}`,
    targetId: (action === 'dismiss' ? parsed.dismissRefId : parsed.orderId) ?? null,
    outcome: result.ok ? 'success' : 'error',
    ...(detail !== null ? { detail } : {}),
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})
