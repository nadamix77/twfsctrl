import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { deleteInstanceSetting, fetchSettingsSnapshot, saveInstanceSetting } from '@/lib/controller/instance-admin'
import { recordAudit } from '@/lib/controller/audit'

// /api/controller/settings/[instanceId] — scalar instance settings
// (Kredensial & X). GET returns the instance's MASKED rows (values
// never leave the instance in clear); POST upserts one key; DELETE
// removes one. Mutations pass the instance's envelope through
// VERBATIM and audit only the key name (FR-F2 — values are secrets).
export const dynamic = 'force-dynamic'
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string }> }

const KEY_MAX = 100
const VALUE_MAX = 5000

function parseKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (key.length === 0 || key.length > KEY_MAX) return null
  return key
}

export const GET = withControllerAuth<RouteContext>(async (_req, { params }) => {
  const { instanceId } = await params
  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const snapshot = await fetchSettingsSnapshot(instance)
  if (snapshot === null) {
    return clientErrorResponse('Pengaturan instance tidak dapat dimuat. Coba lagi nanti.', 502)
  }
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } })
})

export const POST = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { instanceId } = await params

  let body: Record<string, unknown> | null = null
  try {
    const parsed = await req.json()
    body = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    body = null
  }
  const key = parseKey(body?.key)
  if (key == null) return clientErrorResponse('Key tidak valid')
  const value = typeof body?.value === 'string' ? body.value : ''
  if (value.trim().length === 0 || value.length > VALUE_MAX) {
    return clientErrorResponse(`Nilai wajib diisi (maksimal ${VALUE_MAX} karakter)`)
  }

  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const result = await saveInstanceSetting(instance, key, value)

  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: 'settings.save',
    targetId: key,
    outcome: result.ok ? 'success' : 'error',
    ...(result.error != null ? { detail: result.error } : {}),
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})

export const DELETE = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { instanceId } = await params
  const key = parseKey(req.nextUrl.searchParams.get('key'))
  if (key == null) return clientErrorResponse('Key tidak valid')

  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const result = await deleteInstanceSetting(instance, key)

  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: 'settings.delete',
    targetId: key,
    outcome: result.ok ? 'success' : 'error',
    ...(result.error != null ? { detail: result.error } : {}),
    actorIp: getClientIp(req.headers),
  })

  return NextResponse.json(result)
})
