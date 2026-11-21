import { NextResponse } from 'next/server'
import { clientErrorResponse, parseJsonBody } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import {
  deleteInstance,
  getResolvedInstance,
  updateInstance,
  RegistryError,
  type UpdateInstanceParams,
} from '@/lib/controller/registry'
import { recordAudit } from '@/lib/controller/audit'
import type { InstanceUpdateInput } from '@/lib/controller/types'
import { checkAdminPasswordLength, checkColorTag, checkHandle, checkInstanceName } from '../_lib'

// PATCH  /api/controller/instances/[id] — edit registry fields (FR-B3)
// DELETE /api/controller/instances/[id] — remove with typed-name confirm (FR-B4)
//
// PATCH is partial: only the keys present in the body are validated and
// forwarded (`undefined` = keep). A blank adminPassword also keeps the
// stored credential; a non-blank one replaces it (the registry re-encrypts
// and drops the cached instance token). handle/colorTag accept null to
// clear. DELETE requires the operator to type the instance's CURRENT
// display name — a wrong answer is a 400 and nothing is removed. Deletes
// are registry-only: nothing on the instance itself is ever touched.
type RouteContext = { params: Promise<{ id: string }> }

const SORT_ORDER_MIN = 0
const SORT_ORDER_MAX = 999

export const PATCH = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { id } = await params
  const parsed = await parseJsonBody<InstanceUpdateInput>(req)
  if (!parsed.ok) return parsed.response
  const body = parsed.body

  const updates: UpdateInstanceParams = {}

  if (body.name !== undefined) {
    const name = checkInstanceName(body.name)
    if (!name.ok) return clientErrorResponse(name.error)
    updates.name = name.value
  }
  if (body.handle !== undefined) {
    const handle = checkHandle(body.handle)
    if (!handle.ok) return clientErrorResponse(handle.error)
    updates.handle = handle.value
  }
  if (body.colorTag !== undefined) {
    const colorTag = checkColorTag(body.colorTag)
    if (!colorTag.ok) return clientErrorResponse(colorTag.error)
    updates.colorTag = colorTag.value
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return clientErrorResponse('Nilai enabled harus boolean')
    updates.enabled = body.enabled
  }
  if (body.sortOrder !== undefined) {
    if (
      typeof body.sortOrder !== 'number' ||
      !Number.isInteger(body.sortOrder) ||
      body.sortOrder < SORT_ORDER_MIN ||
      body.sortOrder > SORT_ORDER_MAX
    ) {
      return clientErrorResponse(`Sort order harus berupa angka bulat ${SORT_ORDER_MIN}–${SORT_ORDER_MAX}`)
    }
    updates.sortOrder = body.sortOrder
  }
  if (body.adminPassword !== undefined) {
    if (typeof body.adminPassword !== 'string') {
      return clientErrorResponse('Password admin instance tidak valid')
    }
    const passwordError = checkAdminPasswordLength(body.adminPassword)
    if (passwordError) return clientErrorResponse(passwordError)
    // Blank = keep the stored credential; non-blank = replace.
    if (body.adminPassword.length > 0) updates.adminPassword = body.adminPassword
  }

  // Resolve first (mirrors DELETE): an unknown id 404s before any write,
  // and the audit rows below always carry an FK-valid instanceId —
  // recordAudit would otherwise silently drop error entries for ids that
  // no longer exist (best-effort by contract, but avoidable here).
  const existing = await getResolvedInstance(id)
  if (!existing) return clientErrorResponse('Instance tidak ditemukan', 404)

  const actorIp = getClientIp(req.headers)
  try {
    const instance = await updateInstance(id, updates)
    await recordAudit({
      instanceId: instance.id,
      instanceName: instance.name,
      action: 'instance.update',
      outcome: 'success',
      ...(updates.adminPassword !== undefined ? { detail: 'password diganti' } : {}),
      actorIp,
    })
    return NextResponse.json({ instance })
  } catch (e) {
    if (e instanceof RegistryError) {
      await recordAudit({
        instanceId: existing.id,
        instanceName: existing.name,
        action: 'instance.update',
        outcome: 'error',
        detail: e.message,
        actorIp,
      })
      return clientErrorResponse(e.message, e.status)
    }
    throw e
  }
})

export const DELETE = withControllerAuth<RouteContext>(async (req, { params }) => {
  const { id } = await params

  const parsed = await parseJsonBody<{ confirmName?: unknown }>(req)
  if (!parsed.ok) return parsed.response

  const instance = await getResolvedInstance(id)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  // Typed-name confirmation (FR-B4): the exact current display name.
  if (parsed.body.confirmName !== instance.name) {
    return clientErrorResponse('Ketik nama instance untuk konfirmasi penghapusan.')
  }

  const actorIp = getClientIp(req.headers)
  // Audit BEFORE the delete — the AuditLog FK nulls on cascade (SetNull)
  // while the denormalized instanceName keeps the entry readable after.
  await recordAudit({
    instanceId: instance.id,
    instanceName: instance.name,
    action: 'instance.delete',
    outcome: 'success',
    actorIp,
  })
  try {
    await deleteInstance(id)
  } catch (e) {
    if (e instanceof RegistryError) return clientErrorResponse(e.message, e.status)
    throw e
  }
  return NextResponse.json({ success: true })
})
