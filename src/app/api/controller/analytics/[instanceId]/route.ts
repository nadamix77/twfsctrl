import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { fetchAnalytics } from '@/lib/controller/instance-admin'
import type { AnalyticsRange } from '@/lib/controller/types'

// GET /api/controller/analytics/[instanceId]?range= — the instance's
// Statistik payload for one preset window (today | 7d | 30d | month,
// WIB-based on the instance side). Read-only; heavier than the fan-out
// reads, so it is fetched per instance from the client cards, never
// merged blindly across the fleet.
export const dynamic = 'force-dynamic'
export const maxDuration = 30

type RouteContext = { params: Promise<{ instanceId: string }> }

function parseRange(raw: string | null): AnalyticsRange {
  if (raw === 'today' || raw === '7d' || raw === '30d' || raw === 'month') return raw
  return '30d'
}

export const GET = withControllerAuth<RouteContext>(async (req: NextRequest, { params }) => {
  const { instanceId } = await params
  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  const range = parseRange(req.nextUrl.searchParams.get('range'))
  const { analytics, error } = await fetchAnalytics(instance, range)

  if (analytics === null) {
    return clientErrorResponse(error ?? 'Analitik instance tidak dapat dimuat. Coba lagi nanti.', 502)
  }
  return NextResponse.json(
    { analytics, range },
    { headers: { 'Cache-Control': 'no-store' } },
  )
})
