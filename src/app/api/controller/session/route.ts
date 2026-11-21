import { type NextRequest, NextResponse } from 'next/server'
import { getControllerTokenFromRequest, verifyControllerToken } from '@/lib/controller/auth'
import { isControllerAuthConfigured } from '@/lib/controller/config'
import { countInstances } from '@/lib/controller/registry'
import { controllerError } from '@/lib/controller/log'
import { APP_VERSION } from '@/lib/core/constants'
import type { ControllerSessionResponse } from '@/lib/controller/types'

// GET /api/controller/session — Session check (FR-A4)
//
// NOT wrapped in withControllerAuth: unauthenticated callers get
// `{authenticated: false}` instead of a 401 — the login screen boots from
// the same call the dashboard uses (NFR-S4 carves out session-check
// semantics, mirroring the instance app's admin/session split).
// Also carries `configured` (setup hint when env is missing) and
// `instanceCount` for the empty-state CTA.
//
// The panel must keep booting read-only when the controller DB is briefly
// down (NFR-R3 / E13): a failed count reports -1, never a 500.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const authenticated = verifyControllerToken(getControllerTokenFromRequest(req)).authorized

  let instanceCount = -1
  try {
    instanceCount = await countInstances()
  } catch (e) {
    controllerError('session countInstances failed:', e instanceof Error ? e.message : e)
  }

  const body: ControllerSessionResponse = {
    authenticated,
    instanceCount,
    controllerVersion: APP_VERSION,
    configured: isControllerAuthConfigured(),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
