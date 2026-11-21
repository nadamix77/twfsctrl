import { NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { fanOutOverview } from '@/lib/controller/overview'
import { controllerError } from '@/lib/controller/log'

// GET /api/controller/overview — Dashboard fan-out (Epic C, FR-C1–C4)
//
// One GET /api/admin/session per instance, in parallel with an 8 s
// per-instance ceiling — a slow/dead instance degrades only its own card
// (NFR-R1/R2), so a wholesale failure here means the controller itself
// could not read its registry. Answers no-store: the client refreshes on
// its own cadence (FR-C5) and must never render a stale fan-out.
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = withControllerAuth(async () => {
  try {
    return NextResponse.json(await fanOutOverview(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    controllerError('overview fan-out failed:', e instanceof Error ? e.message : e)
    return clientErrorResponse('Gagal memuat overview. Coba lagi nanti.', 500)
  }
})
