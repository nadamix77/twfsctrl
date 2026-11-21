import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { fanOutSubmitters } from '@/lib/controller/submitters'
import { controllerError } from '@/lib/controller/log'

// GET /api/controller/submitters — Unified submitters (Pengirim) fan-out
//
// Query params:
//   page      integer 1–100 (default 1)
//   search    free text on username/displayName, ≤100 chars (delegated)
//   instances comma-separated instance ids restricting the fan-out
//
// Responds no-store — the list reflects live instance state.
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const PAGE_MAX = 100
const SEARCH_MAX = 100

function parsePageParam(raw: string | null): number | null {
  if (raw === null || raw === '') return 1
  const page = Number(raw)
  if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) return null
  return page
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

  const page = parsePageParam(params.get('page'))
  if (page === null) return clientErrorResponse(`Parameter page harus berupa angka 1–${PAGE_MAX}`)

  const search = parseSearchParams(params.get('search'))
  if (!search.ok) return clientErrorResponse(search.error)

  const instanceIds = parseInstancesParam(params.get('instances'))

  try {
    const result = await fanOutSubmitters({ page, search: search.value, instanceIds })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    controllerError('submitters fan-out failed:', e instanceof Error ? e.message : e)
    return clientErrorResponse('Gagal memuat daftar pengirim. Coba lagi nanti.', 500)
  }
})
