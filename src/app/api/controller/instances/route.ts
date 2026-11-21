import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse, parseJsonBody } from '@/lib/core/api-response'
import { getClientIp } from '@/lib/auth/login-rate-limit'
import { withControllerAuth } from '@/lib/controller/auth'
import { createInstance, listInstances, RegistryError } from '@/lib/controller/registry'
import { validateInstanceBaseUrl } from '@/lib/controller/instance-url'
import { recordAudit } from '@/lib/controller/audit'
import type { InstanceCreateInput } from '@/lib/controller/types'
import { checkAdminPasswordLength, checkColorTag, checkHandle, checkInstanceName } from './_lib'

// GET  /api/controller/instances — list the registry (FR-B1)
// POST /api/controller/instances — register a new instance (FR-B1/B7/B8)
//
// GET returns every row (enabled + disabled — FR-B5 keeps disabled rows
// visible, greyed, in the registry list). POST validates the display
// name (1–40 chars, no control characters), the write-only admin
// password (≤200), and the base URL through the SSRF-guarding
// normalizer (FR-B8) before the registry enforces name/URL uniqueness
// (FR-B7). Credentials are encrypted at rest inside the registry layer
// and never appear in any response (FR-B6).
export const dynamic = 'force-dynamic'

export const GET = withControllerAuth(async () => {
  return NextResponse.json({ instances: await listInstances() })
})

export const POST = withControllerAuth(async (req: NextRequest) => {
  const parsed = await parseJsonBody<InstanceCreateInput>(req)
  if (!parsed.ok) return parsed.response
  const body = parsed.body

  const name = checkInstanceName(body.name)
  if (!name.ok) return clientErrorResponse(name.error)

  if (typeof body.adminPassword !== 'string' || body.adminPassword.length === 0) {
    return clientErrorResponse('Password admin instance wajib diisi')
  }
  const passwordError = checkAdminPasswordLength(body.adminPassword)
  if (passwordError) return clientErrorResponse(passwordError)

  const url = await validateInstanceBaseUrl(body.baseUrl)
  if (!url.ok) return clientErrorResponse(url.error)

  const handle = checkHandle(body.handle)
  if (!handle.ok) return clientErrorResponse(handle.error)

  const colorTag = checkColorTag(body.colorTag)
  if (!colorTag.ok) return clientErrorResponse(colorTag.error)

  const actorIp = getClientIp(req.headers)
  try {
    const instance = await createInstance({
      name: name.value,
      baseUrl: url.url,
      adminPassword: body.adminPassword,
      handle: handle.value,
      colorTag: colorTag.value,
    })
    await recordAudit({
      instanceId: instance.id,
      instanceName: instance.name,
      action: 'instance.create',
      outcome: 'success',
      detail: instance.baseUrl,
      actorIp,
    })
    return NextResponse.json({ instance }, { status: 201 })
  } catch (e) {
    if (e instanceof RegistryError) {
      await recordAudit({
        instanceName: name.value,
        action: 'instance.create',
        outcome: 'error',
        detail: e.message,
        actorIp,
      })
      return clientErrorResponse(e.message, e.status)
    }
    throw e
  }
})
