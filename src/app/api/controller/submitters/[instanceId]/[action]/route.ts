import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { performSubmitterAction, type SubmitterActionPayload } from '@/lib/controller/submitters'
import { recordAudit } from '@/lib/controller/audit'
import type { QuickActionResponse, SubmitterAction } from '@/lib/controller/types'

// POST /api/controller/submitters/[instanceId]/[action] — submitter
// management on one instance (block / unblock / whitelist / image
// allowlist / overrides / points-adjust).
//
// Whitelisted verbs map to the instance's dedicated admin routes; the
// instance's status + JSON envelope passes through VERBATIM as HTTP 200
// (QuickActionResponse) so the client renders instance copy exactly.
//
// Audit records the username as targetId — never the reason/note text
// (FR-F2: no free-text content in the audit trail).
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string; action: string }> }

const VALID_ACTIONS = new Set<string>([
  'block',
  'unblock',
  'whitelist',
  'whitelist-remove',
  'image-allow',
  'image-deny',
  'overrides',
  'points-adjust',
])

function parseAction(value: string): SubmitterAction | null {
  return VALID_ACTIONS.has(value) ? (value as SubmitterAction) : null
}

const USERNAME_MAX = 30
const REASON_MAX = 200
const NOTE_MAX = 200

/** Validate the JSON body per action. Returns the instance-bound
 *  payload, or an error string (client-side validation only — the
 *  instance re-validates authoritatively). */
function parsePayload(
  action: SubmitterAction,
  body: Record<string, unknown> | null,
): { ok: true; payload: SubmitterActionPayload } | { ok: false; error: string } {
  if (body == null) return { ok: false, error: 'Body permintaan tidak valid' }

  const usernameRaw = typeof body.username === 'string' ? body.username.trim() : ''
  if (usernameRaw.length === 0 || usernameRaw.length > USERNAME_MAX) {
    return { ok: false, error: 'Username wajib diisi (maksimal 30 karakter)' }
  }
  const payload: SubmitterActionPayload = { username: usernameRaw }

  if (action === 'block') {
    if (body.reason != null) {
      if (typeof body.reason !== 'string') return { ok: false, error: 'Alasan blokir tidak valid' }
      const reason = body.reason.trim()
      if (reason.length > REASON_MAX) return { ok: false, error: `Alasan maksimal ${REASON_MAX} karakter` }
      payload.reason = reason.length > 0 ? reason : null
    }
  }

  if (action === 'points-adjust') {
    const delta = body.delta
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
      return { ok: false, error: 'Delta harus bilangan bulat tidak nol' }
    }
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (note.length === 0 || note.length > NOTE_MAX) {
      return { ok: false, error: `Catatan wajib diisi (maksimal ${NOTE_MAX} karakter)` }
    }
    payload.delta = delta
    payload.note = note
  }

  if (action === 'overrides') {
    const limits = parseOverrideFamily(body.customLimits, 'customLimits')
    if ('error' in limits) return { ok: false, error: limits.error }
    const pricing = parseOverrideFamily(body.customPricing, 'customPricing')
    if ('error' in pricing) return { ok: false, error: pricing.error }
    if (!limits.present && !pricing.present) {
      return { ok: false, error: 'Minimal satu keluarga override harus diisi' }
    }
    if (limits.present) payload.customLimits = limits.value
    if (pricing.present) payload.customPricing = pricing.value
  }

  return { ok: true, payload }
}

/** One overrides family: absent → untouched; null → clear-all; an
 *  object → per-key set (null members = per-key removal). Built via
 *  entries + fromEntries — no computed member writes (SAST idiom). */
type FamilyParse =
  | { present: false }
  | { present: true; value: Record<string, number> | null }
  | { error: string }

function parseOverrideFamily(raw: unknown, label: string): FamilyParse {
  if (raw === undefined) return { present: false }
  if (raw === null) return { present: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: `Struktur ${label} tidak valid` }
  const entries: Array<[string, number]> = []
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) continue // per-key removal — the instance accepts null members
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { error: `Nilai ${label}.${key} harus angka` }
    }
    entries.push([key, value])
  }
  return { present: true, value: Object.fromEntries(entries) }
}

/** Audit detail: the outcome keyword from the instance body (balance /
 *  blocked / …) or the error string — never free-text content (FR-F2). */
function actionDetail(result: QuickActionResponse): string | null {
  if (!result.ok) return result.error
  const b = result.body as Record<string, unknown> | null
  if (b == null || typeof b !== 'object') return null
  if (typeof b.balance === 'number') return `balance=${b.balance}`
  return null
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

  const result = await performSubmitterAction(instance, action, parsed.payload)

  const detail = actionDetail(result)
  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: `submitter.${action}`,
    targetId: parsed.payload.username,
    outcome: result.ok ? 'success' : 'error',
    ...(detail !== null ? { detail } : {}),
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})
