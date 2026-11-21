import { type NextRequest, NextResponse } from 'next/server'
import { clientErrorResponse } from '@/lib/core/api-response'
import { withControllerAuth } from '@/lib/controller/auth'
import { getResolvedInstance } from '@/lib/controller/registry'
import { callInstanceMedia } from '@/lib/controller/instance-client'

// GET /api/controller/media/[instanceId]/[submissionId] — media proxy
//
// Instance media is auth-gated (/api/media/:id on the instance); the
// browser can never hit it directly (§6.2 rule 2). The controller_token
// cookie rides along on <img> loads (SameSite=Strict, same-origin), the
// route swaps it for the instance's admin token server-side, and streams
// the bytes back from the controller origin. The `?v=` cache-buster is
// forwarded verbatim; the browser's If-None-Match is forwarded so 304
// revalidations stay free. The PATH is stable forever while the FULL URL
// is content-versioned — same caching doctrine as the instance media
// route (private, max-age=86400, immutable).
type RouteContext = { params: Promise<{ instanceId: string; submissionId: string }> }

const MEDIA_CACHE_CONTROL = 'private, max-age=86400, immutable'

/** Copy the fetched bytes into a fresh ArrayBuffer — the response body
 *  must never alias the upstream buffer (same doctrine as the instance
 *  media route's toResponseBody). */
function toResponseBody(source: ArrayBuffer): ArrayBuffer {
  const copy = new ArrayBuffer(source.byteLength)
  new Uint8Array(copy).set(new Uint8Array(source))
  return copy
}

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = withControllerAuth<RouteContext>(async (req: NextRequest, { params }) => {
  const { instanceId, submissionId } = await params

  const instance = await getResolvedInstance(instanceId)
  if (!instance) return clientErrorResponse('Instance tidak ditemukan', 404)

  // Cache-buster forwarded verbatim; the id is re-encoded for the
  // upstream path (params here arrive URL-decoded).
  const version = req.nextUrl.searchParams.get('v')
  const query = new URLSearchParams()
  if (version) query.set('v', version)
  const path = `/api/media/${encodeURIComponent(submissionId)}${version ? `?${query.toString()}` : ''}`

  const result = await callInstanceMedia(
    { key: instance.id, baseUrl: instance.baseUrl, password: instance.password },
    path,
    req.headers.get('if-none-match'),
  )

  // Call-level failure (network/login) — 502 with the client's own text.
  if (!result.ok) {
    return clientErrorResponse(result.error, 502)
  }

  if (result.status === 304) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ...(result.etag !== null ? { ETag: result.etag } : {}),
        'Cache-Control': MEDIA_CACHE_CONTROL,
      },
    })
  }

  if (result.status === 200) {
    if (result.buffer === null) return clientErrorResponse('Gambar tidak dapat dimuat.', 502)
    return new NextResponse(toResponseBody(result.buffer), {
      status: 200,
      headers: {
        'Cache-Control': MEDIA_CACHE_CONTROL,
        ...(result.etag !== null ? { ETag: result.etag } : {}),
        'Content-Type': result.contentType ?? 'image/jpeg',
        // Defense in depth: a private media route must never be sniffed.
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  if (result.status === 404) {
    return clientErrorResponse('Gambar tidak ditemukan.', 404)
  }

  // Any other instance status mirrors through with controller copy —
  // the binary channel carries no instance JSON to pass along.
  return NextResponse.json({ error: 'Gambar tidak dapat dimuat.' }, { status: result.status })
})
