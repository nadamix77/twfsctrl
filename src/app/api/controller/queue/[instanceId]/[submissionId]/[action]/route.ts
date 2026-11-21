import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { performQueueAction } from '@/lib/controller/actions'
import { recordAudit } from '@/lib/controller/audit'
import type {
  CensorRegionInput,
  QueueAction,
  QueueActionPayload,
  QueueActionResponse,
} from '@/lib/controller/types'

// POST /api/controller/queue/[instanceId]/[submissionId]/[action] —
// moderation actions on one instance submission (FR-D4–D8)
//
// Whitelisted verbs: approve | reject | retry | refund | delete | edit |
// censor. The instance's status + JSON body envelope passes through
// VERBATIM as HTTP 200 (QueueActionResponse) so the client renders
// instance copy exactly — 409 CAS conflicts, 503 breaker deferrals and
// the rest keep their own status INSIDE the envelope for the client to
// branch on. Params arrive URL-decoded; performQueueAction re-encodes
// the id for the upstream path.
//
// `edit` (PUT — message-only content edit) and `censor` (POST …/censor
// — region image censor) carry a JSON request body. The controller
// validates the payload defensively (bounds + whitelist) BEFORE the
// fan-out — the instance remains the source of truth for semantics
// (its own validators run again upstream).
//
// Audit detail records the instance's outcome `kind` (auto-posted /
// queued / error / …), the edit's changed/no-op flag, the censor
// region count, or the error string — never message content (FR-F2).
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string; submissionId: string; action: string }> }

/** Whitelist parse — literal comparisons only, no dynamic dispatch. */
function parseQueueAction(value: string): QueueAction | null {
  if (
    value === 'approve' ||
    value === 'reject' ||
    value === 'retry' ||
    value === 'refund' ||
    value === 'delete' ||
    value === 'edit' ||
    value === 'censor'
  ) {
    return value
  }
  return null
}

// ── Payload validation (defensive, NFR-X1) ──────────────────

const MAX_EDIT_MESSAGE_LENGTH = 5_000
const MAX_CENSOR_REGIONS = 16
const REGION_COORD_EPS = 1e-6
const REGION_TYPES = new Set(['pixelate', 'blur', 'black'])

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Parse + bound the edit/censor request body. Returns the sanitized
 *  payload, or a Indonesian error string when the shape is unusable. */
function parseActionPayload(action: QueueAction, raw: unknown): QueueActionPayload | string {
  if (action !== 'edit' && action !== 'censor') return {}

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'Body permintaan tidak valid'
  }
  const body = raw as Record<string, unknown>

  if (action === 'edit') {
    const message = body.message
    if (typeof message !== 'string' || message.length === 0) return 'Pesan wajib diisi'
    if (message.length > MAX_EDIT_MESSAGE_LENGTH) return 'Pesan terlalu panjang'
    return { message }
  }

  const regions = body.regions
  if (!Array.isArray(regions) || regions.length === 0) return 'Minimal satu area sensor diperlukan'
  if (regions.length > MAX_CENSOR_REGIONS) return `Maksimal ${MAX_CENSOR_REGIONS} area sensor`

  const out: CensorRegionInput[] = []
  for (const region of regions) {
    if (region == null || typeof region !== 'object' || Array.isArray(region)) {
      return 'Format area sensor tidak valid'
    }
    const r = region as Record<string, unknown>
    if (!(finite(r.x) && finite(r.y) && finite(r.w) && finite(r.h))) {
      return 'Format area sensor tidak valid'
    }
    if (
      r.x < 0 ||
      r.x > 1 ||
      r.y < 0 ||
      r.y > 1 ||
      r.w <= 0 ||
      r.h <= 0 ||
      r.x + r.w > 1 + REGION_COORD_EPS ||
      r.y + r.h > 1 + REGION_COORD_EPS
    ) {
      return 'Area sensor keluar dari batas gambar'
    }
    if (typeof r.type !== 'string' || !REGION_TYPES.has(r.type)) {
      return 'Jenis sensor tidak valid'
    }
    const sanitized: CensorRegionInput = { x: r.x, y: r.y, w: r.w, h: r.h, type: r.type as CensorRegionInput['type'] }
    if (r.angle !== undefined) {
      if (!finite(r.angle) || r.angle < -180 || r.angle > 180) return 'Sudut rotasi tidak valid'
      if (r.angle !== 0) sanitized.angle = r.angle
    }
    out.push(sanitized)
  }
  return { regions: out }
}

/** Audit detail: the instance's outcome `kind` on success, its error
 *  string on failure — never submission content (FR-F2). */
function queueActionDetail(action: QueueAction, result: QueueActionResponse): string | null {
  if (!result.ok) return result.error
  const body = result.body as Record<string, unknown> | null
  if (action === 'edit') {
    return body?.changed === true ? 'changed' : body?.changed === false ? 'no-op' : null
  }
  if (action === 'censor') {
    const count = body?.regions
    return typeof count === 'number' && Number.isFinite(count) ? `regions:${count}` : null
  }
  const kind = body?.kind
  return typeof kind === 'string' && kind.length > 0 ? kind : null
}

export const POST = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { instanceId, submissionId, action: rawAction } = await params

  const action = parseQueueAction(rawAction)
  if (action === null) return clientErrorResponse('Aksi tidak dikenal')

  // Body-carrying verbs only — the bodyless verbs never read the stream.
  let rawBody: unknown = null
  if (action === 'edit' || action === 'censor') {
    try {
      rawBody = await req.json()
    } catch {
      return clientErrorResponse('Body permintaan tidak valid')
    }
  }
  const payload = parseActionPayload(action, rawBody)
  if (typeof payload === 'string') return clientErrorResponse(payload)

  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const result = await performQueueAction(instance, submissionId, action, payload)

  const detail = queueActionDetail(action, result)
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
