import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { fetchFilterSettings, saveFilterSettings } from '@/lib/controller/instance-admin'
import { recordAudit } from '@/lib/controller/audit'

// /api/controller/filter-settings/[instanceId] — the instance's batched
// filter settings (the admin UI's Settings tabs). GET returns the
// defensively parsed snapshot; POST forwards a partial patch object —
// the instance validates groups + bounds in one transaction and its
// envelope passes through VERBATIM. Audit detail carries only the
// GROUP names touched (FR-F2 — never values).
export const dynamic = 'force-dynamic'
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string }> }

const GROUPS_MAX = 20

export const GET = withControllerAuth<RouteContext>(async (_req, { params }) => {
  const { instanceId } = await params
  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const snapshot = await fetchFilterSettings(instance)
  if (snapshot === null) {
    return clientErrorResponse('Pengaturan filter instance tidak dapat dimuat. Coba lagi nanti.', 502)
  }
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } })
})

export const POST = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { instanceId } = await params

  let patch: Record<string, unknown> | null = null
  try {
    const parsed = await req.json()
    patch = parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    patch = null
  }
  if (patch == null || Object.keys(patch).length === 0) {
    return clientErrorResponse('Body harus berisi minimal satu grup setting')
  }
  if (Object.keys(patch).length > GROUPS_MAX) {
    return clientErrorResponse(`Maksimal ${GROUPS_MAX} grup per permintaan`)
  }

  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const result = await saveFilterSettings(instance, patch)

  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: 'filter.update',
    targetId: Object.keys(patch).sort().join(',').slice(0, 200),
    outcome: result.ok ? 'success' : 'error',
    ...(result.error != null ? { detail: result.error } : {}),
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})
