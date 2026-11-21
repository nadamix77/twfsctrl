import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { fanOutPayments } from '@/lib/controller/payments'
import { controllerError } from '@/lib/controller/log'
import type { PaymentStatusFilter } from '@/lib/controller/types'

// GET /api/controller/payments — Unified payments (Monetisasi) fan-out
//
// Query params:
//   status    one of all|pending|paid|expired (default all)
//   purpose   optional one of topup|unblock
//   page      integer 1–100 (default 1)
//   instances comma-separated instance ids restricting the fan-out
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const PAGE_MAX = 100

function parseStatusFilter(raw: string | null): PaymentStatusFilter | null {
  if (raw === null || raw === '') return 'all'
  if (raw === 'all' || raw === 'pending' || raw === 'paid' || raw === 'expired') return raw
  return null
}

function parsePurposeFilter(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed === 'topup' || trimmed === 'unblock') return trimmed
  return '?'
}

function parsePageParam(raw: string | null): number | null {
  if (raw === null || raw === '') return 1
  const page = Number(raw)
  if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) return null
  return page
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

  const status = parseStatusFilter(params.get('status'))
  if (status === null) return clientErrorResponse('Parameter status tidak valid')

  const purpose = parsePurposeFilter(params.get('purpose'))
  if (purpose === '?') return clientErrorResponse('Parameter purpose tidak valid')

  const page = parsePageParam(params.get('page'))
  if (page === null) return clientErrorResponse(`Parameter page harus berupa angka 1–${PAGE_MAX}`)

  const instanceIds = parseInstancesParam(params.get('instances'))

  try {
    const result = await fanOutPayments({ status, purpose, page, instanceIds })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    controllerError('payments fan-out failed:', e instanceof Error ? e.message : e)
    return clientErrorResponse('Gagal memuat daftar pembayaran. Coba lagi nanti.', 500)
  }
})
