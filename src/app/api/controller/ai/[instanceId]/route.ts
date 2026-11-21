import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { fetchAiSnapshot } from '@/lib/controller/instance-admin'

// GET /api/controller/ai/[instanceId] — AI provider health + decision
// stats for one instance. Read-only (provider/key editing stays on the
// instance's own admin UI — the controller never proxies secrets it
// cannot render safely).
export const dynamic = 'force-dynamic'
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string }> }

export const GET = withControllerAuth<RouteContext>(async (_req, { params }) => {
  const { instanceId } = await params
  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const snapshot = await fetchAiSnapshot(instance)
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } })
})
