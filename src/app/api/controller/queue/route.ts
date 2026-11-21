import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { fanOutQueue, QUEUE_PAGE_LIMIT } from '@/lib/controller/queue'
import { controllerError } from '@/lib/controller/log'
import type { QueueStatusFilter } from '@/lib/controller/types'

// GET /api/controller/queue — Unified moderation queue fan-out (Epic D)
//
// Query params:
//   status    one of all|pending|censored|posting|post_failed|rejected|
//             posted (default all — passed straight through to the
//             instance contract, where 'all' is its own default list
//             filter spanning every status; rejected is the FR-D8
//             refund tab, posting and posted are live/history tabs)
//   page      integer 1–100 (default 1)
//   limit     integer ≥1, clamped to QUEUE_PAGE_LIMIT (default 50)
//   search    free text, trimmed, ≤100 chars (delegated per instance)
//   instances comma-separated instance ids restricting the fan-out
//
// Responds no-store — the queue reflects live instance state on every
// fetch, never a cached merge.
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const PAGE_MAX = 100
const SEARCH_MAX = 100

/** Whitelist parse — literal comparisons only. */
function parseStatusFilter(raw: string | null): QueueStatusFilter | null {
  if (raw === null || raw === '') return 'all'
  if (
    raw === 'all' || raw === 'pending' || raw === 'censored' || raw === 'posting' ||
    raw === 'post_failed' || raw === 'rejected' || raw === 'posted'
  ) return raw
  return null
}

function parsePageParam(raw: string | null): number | null {
  if (raw === null || raw === '') return 1
  const page = Number(raw)
  if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) return null
  return page
}

function parseLimitParam(raw: string | null): number | null {
  if (raw === null || raw === '') return QUEUE_PAGE_LIMIT
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1) return null
  return Math.min(limit, QUEUE_PAGE_LIMIT)
}

function parseSearchParams(raw: string | null): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (trimmed.length > SEARCH_MAX) {
    return { ok: false, error: `Parameter search maksimal ${SEARCH_MAX} karakter` }
  }
  return { ok: true, value: trimmed }
}

/** Comma-separated instance ids → array; blank/absent → null (no filter). */
function parseInstancesParam(raw: string | null): string[] | null {
  if (raw === null) return null
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return ids.length > 0 ? ids : null
}

export const GET = withControllerAuth(async (req: NextRequest) => {
  const params = req.nextUrl.searchParams

  const status = parseStatusFilter(params.get('status'))
  if (status === null) return clientErrorResponse('Parameter status tidak valid')

  const page = parsePageParam(params.get('page'))
  if (page === null) return clientErrorResponse(`Parameter page harus berupa angka 1–${PAGE_MAX}`)

  const limit = parseLimitParam(params.get('limit'))
  if (limit === null) return clientErrorResponse('Parameter limit tidak valid')

  const search = parseSearchParams(params.get('search'))
  if (!search.ok) return clientErrorResponse(search.error)

  const instanceIds = parseInstancesParam(params.get('instances'))

  try {
    const result = await fanOutQueue({ status, page, limit, search: search.value, instanceIds })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    controllerError('queue fan-out failed:', e instanceof Error ? e.message : e)
    return clientErrorResponse('Gagal memuat antrian. Coba lagi nanti.', 500)
  }
})
