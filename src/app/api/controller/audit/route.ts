import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { listAuditActions, listAuditEntries } from '@/lib/controller/audit'
import { controllerError } from '@/lib/controller/log'
import type { AuditListResponse } from '@/lib/controller/types'

// GET /api/controller/audit — audit log viewer feed (FR-F3)
//
// Newest-first, filterable by instanceId and action, paginated. The
// response also carries the distinct action names for the filter
// dropdown. Reads sweep entries older than 90 days (retention, FR-F3).
// Answers no-store — the log is append-only and must never serve stale.
export const dynamic = 'force-dynamic'

const LIMIT_DEFAULT = 50
const LIMIT_MAX = 200

function parsePageParam(raw: string | null): number | null {
  if (raw === null || raw === '') return 1
  const page = Number(raw)
  if (!Number.isInteger(page) || page < 1) return null
  return page
}

function parseLimitParam(raw: string | null): number | null {
  if (raw === null || raw === '') return LIMIT_DEFAULT
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1) return null
  return Math.min(limit, LIMIT_MAX)
}

/** Optional string filter: blank/absent → null (no filter). */
function parseFilterParam(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const GET = withControllerAuth(async (req: NextRequest) => {
  const params = req.nextUrl.searchParams

  const page = parsePageParam(params.get('page'))
  if (page === null) return clientErrorResponse('Parameter page tidak valid')

  const limit = parseLimitParam(params.get('limit'))
  if (limit === null) return clientErrorResponse('Parameter limit tidak valid')

  const instanceId = parseFilterParam(params.get('instanceId'))
  const action = parseFilterParam(params.get('action'))

  try {
    const [list, actions] = await Promise.all([
      listAuditEntries({ instanceId, action, page, limit }),
      listAuditActions(),
    ])
    const body: AuditListResponse = { ...list, actions }
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    controllerError('audit list failed:', e instanceof Error ? e.message : e)
    return clientErrorResponse('Gagal memuat audit log. Coba lagi nanti.', 500)
  }
})
