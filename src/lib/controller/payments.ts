// ============================================================
// payments.ts — Unified payments (Monetisasi) fan-out
//
// Merged order list + revenue aggregates + GoBiz health from every
// ENABLED instance (queue.ts doctrine: per-instance sections, a
// degraded instance freezes its own slice). Confirm / void /
// dismiss-ambiguous are thin translations to the instance's repair
// routes — the instance's status + body envelope passes through
// VERBATIM (C4 doctrine), so the client renders instance copy.
// ============================================================

import { callInstance, type InstanceTarget } from './instance-client'
import { loadResolvedInstances, type ResolvedInstance } from './registry'
import { controllerDebug } from './log'
import { readInt, readIso, readNum, readPagination, readStr } from './parse'
import type {
  PaymentAction,
  PaymentOrder,
  PaymentsResponse,
  PaymentsSection,
  PaymentStatusFilter,
  QuickActionResponse,
  UnmatchedCredit,
} from './types'

export const PAYMENTS_PAGE_LIMIT = 30

export interface PaymentsFanOutParams {
  status: PaymentStatusFilter
  purpose: string | null
  page: number
  /** Restrict fan-out to specific instance ids (filter chips). */
  instanceIds?: string[] | null
}

function targetOf(instance: ResolvedInstance): InstanceTarget {
  return { key: instance.id, baseUrl: instance.baseUrl, password: instance.password ?? '' }
}

/** Map one instance order row → PaymentOrder (NFR-X1 defensive). */
function mapOrder(row: unknown, instance: ResolvedInstance): PaymentOrder | null {
  if (row == null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const id = readStr(r.id)
  if (id == null) return null
  return {
    instanceId: instance.id,
    instanceName: instance.name,
    instanceColor: instance.colorTag,
    id,
    username: readStr(r.username) ?? '',
    purpose: typeof r.purpose === 'string' ? r.purpose : '',
    points: readInt(r.points),
    amountIdr: readInt(r.amountIdr),
    status: typeof r.status === 'string' ? r.status : '',
    verifiedBy: readStr(r.verifiedBy),
    refId: readStr(r.refId),
    expiresAt: readIso(r.expiresAt),
    paidAt: readIso(r.paidAt),
    createdAt: readIso(r.createdAt) ?? new Date(0).toISOString(),
  }
}

/** Map one orphan/ambiguous credit row (three-field shape). */
function mapCredit(row: unknown): UnmatchedCredit | null {
  if (row == null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const refId = readStr(r.refId)
  if (refId == null) return null
  return { refId, amountIdr: readInt(r.amountIdr), date: readIso(r.date) }
}

/** Map the payments response body's gobiz block. */
function mapGobiz(body: unknown): PaymentsSection['gobiz'] {
  if (body == null || typeof body !== 'object') return null
  const raw = (body as Record<string, unknown>).gobiz
  if (raw == null || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>

  const healthRaw = g.health != null && typeof g.health === 'object' ? g.health as Record<string, unknown> : null
  const refreshRaw = g.refresh != null && typeof g.refresh === 'object' ? g.refresh as Record<string, unknown> : null

  return {
    health: healthRaw == null
      ? null
      : {
          lastSuccessAt: readIso(healthRaw.lastSuccessAt),
          lastFailureAt: readIso(healthRaw.lastFailureAt),
          consecutiveFailures: readInt(healthRaw.consecutiveFailures),
        },
    refresh: refreshRaw == null
      ? null
      : {
          configured: typeof refreshRaw.configured === 'boolean' ? refreshRaw.configured : null,
          blockedUntil: readIso(refreshRaw.blockedUntil),
          consecutiveRejections: readInt(refreshRaw.consecutiveRejections),
        },
    orphans: Array.isArray(g.orphans)
      ? g.orphans.map(mapCredit).filter((c): c is UnmatchedCredit => c !== null)
      : [],
    ambiguous: Array.isArray(g.ambiguous)
      ? g.ambiguous.map(mapCredit).filter((c): c is UnmatchedCredit => c !== null)
      : [],
    error: readStr(g.error),
  }
}

/** Fan out the payments list across all enabled instances. */
export async function fanOutPayments(params: PaymentsFanOutParams): Promise<PaymentsResponse> {
  const all = await loadResolvedInstances(true)
  const targets = params.instanceIds?.length
    ? all.filter((instance) => params.instanceIds?.includes(instance.id))
    : all

  const fetchedAt = new Date().toISOString()

  const sections = await Promise.all(
    targets.map(async (instance): Promise<PaymentsSection> => {
      const base: PaymentsSection = {
        instanceId: instance.id,
        instanceName: instance.name,
        instanceColor: instance.colorTag,
        health: 'ok',
        error: null,
        retryAfterSec: null,
        orders: [],
        page: params.page,
        hasMore: false,
        total: 0,
        revenue: null,
        gobiz: null,
        lastFetchedAt: fetchedAt,
      }

      if (instance.credentialError || !instance.password) {
        return {
          ...base,
          health: 'auth-failed',
          error: instance.credentialError ?? 'Password instance belum tersimpan',
        }
      }

      const query = new URLSearchParams({ page: String(params.page) })
      if (params.status !== 'all') query.set('status', params.status)
      if (params.purpose) query.set('purpose', params.purpose)

      const startedAt = Date.now()
      const call = await callInstance(targetOf(instance), `/api/admin/payments?${query.toString()}`)
      const ms = Date.now() - startedAt

      if (!call.ok) {
        controllerDebug('controller:payments', `instance=${instance.name} ms=${ms} health=${call.kind}`)
        return { ...base, health: call.kind, error: call.error, retryAfterSec: call.retryAfterSec }
      }
      controllerDebug('controller:payments', `instance=${instance.name} ms=${ms} http=${call.status}`)

      if (call.status !== 200) {
        const errorBody = call.body as { error?: unknown } | null
        return {
          ...base,
          health: 'down',
          error:
            typeof errorBody?.error === 'string' && errorBody.error
              ? errorBody.error
              : `Instance menjawab ${call.status}`,
        }
      }

      const { items, total, hasMore } = readPagination(call.body, 'orders')
      const orders = items
        .map((row) => mapOrder(row, instance))
        .filter((order): order is PaymentOrder => order !== null)

      const revenueRaw = call.body != null && typeof call.body === 'object'
        ? (call.body as Record<string, unknown>).revenue
        : null
      const revenue = revenueRaw != null && typeof revenueRaw === 'object'
        ? {
            todayIdr: readNum((revenueRaw as Record<string, unknown>).todayIdr),
            totalIdr: readNum((revenueRaw as Record<string, unknown>).totalIdr),
          }
        : null

      return {
        ...base,
        orders,
        total,
        hasMore,
        revenue,
        gobiz: mapGobiz(call.body),
      }
    }),
  )

  return { sections, fetchedAt }
}

// ── Actions ─────────────────────────────────────────────────

export interface PaymentActionPayload {
  /** confirm / void: the order id. */
  orderId?: string | undefined
  /** confirm: mandatory audit note. */
  note?: string | null
  /** confirm: optional GoBiz statement reference (gobiz:<txId>). */
  refId?: string | null
  /** dismiss: the ambiguous hold's refId. */
  dismissRefId?: string | undefined
}

/** Execute one payment repair action against one instance. */
export async function performPaymentAction(
  instance: ResolvedInstance,
  action: PaymentAction,
  payload: PaymentActionPayload,
): Promise<QuickActionResponse> {
  const target = targetOf(instance)
  const jsonHeaders = { 'Content-Type': 'application/json' }

  let call: Awaited<ReturnType<typeof callInstance>>
  switch (action) {
    case 'confirm': {
      if (payload.orderId == null) {
        return { ok: false, status: 0, body: null, error: 'ID order wajib diisi' }
      }
      const body: Record<string, unknown> = { note: payload.note ?? '' }
      if (payload.refId != null && payload.refId.length > 0) body.refId = payload.refId
      call = await callInstance(
        target,
        `/api/admin/payments/${encodeURIComponent(payload.orderId)}/confirm`,
        { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) },
      )
      break
    }
    case 'void': {
      if (payload.orderId == null) {
        return { ok: false, status: 0, body: null, error: 'ID order wajib diisi' }
      }
      call = await callInstance(
        target,
        `/api/admin/payments/${encodeURIComponent(payload.orderId)}/void`,
        { method: 'POST' },
      )
      break
    }
    case 'dismiss': {
      if (payload.dismissRefId == null || payload.dismissRefId.length === 0) {
        return { ok: false, status: 0, body: null, error: 'refId wajib diisi' }
      }
      call = await callInstance(
        target,
        `/api/admin/payments/ambiguous/${encodeURIComponent(payload.dismissRefId)}/dismiss`,
        { method: 'POST' },
      )
      break
    }
    default:
      return { ok: false, status: 0, body: null, error: 'Aksi tidak dikenal' }
  }

  if (!call.ok) {
    return { ok: false, status: call.status, body: null, error: call.error }
  }

  const errorBody = call.body as { error?: unknown } | null
  const errorText =
    call.status >= 400 && typeof errorBody?.error === 'string' && errorBody.error ? errorBody.error : null

  return { ok: call.status >= 200 && call.status < 300, status: call.status, body: call.body, error: errorText }
}

/** Defensive readers for the confirm body the UI toasts on. */
export function readPaymentActionBody(body: unknown): {
  latePayment?: boolean | undefined
  overBalance?: boolean | undefined
} {
  if (body == null || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  return {
    latePayment: b.latePayment === true ? true : undefined,
    overBalance: b.overBalance === true ? true : undefined,
  }
}
