// ============================================================
// queue.ts — Unified moderation queue fan-out (Epic D)
//
// Merged view of reviewable submissions (pending / censored /
// post_failed) from every ENABLED instance. The 'all' tab performs
// three parallel per-instance calls (one per status) so pagination
// stays per-status-correct; specific tabs perform one. Sections are
// per-instance so a degraded instance freezes its OWN slice only
// (FR-D11) while the client flattens + sorts by createdAt desc.
//
// Images: instance media is auth-gated (/api/media/:id), so rows
// carry a CONTROLLER-relative proxy URL — the browser never talks
// to the instance directly (§6.2 rule 2).
// ============================================================

import { callInstance } from './instance-client'
import { loadResolvedInstances, type ResolvedInstance } from './registry'
import { controllerDebug } from './log'
import type { InstanceHealth, QueueItem, QueueResponse, QueueSection, QueueStatusFilter } from './types'

export const REVIEWABLE_STATUSES = ['pending', 'censored', 'post_failed'] as const
export const QUEUE_PAGE_LIMIT = 50

export interface QueueFanOutParams {
  status: QueueStatusFilter
  page: number
  limit: number
  search: string | null
  /** Restrict fan-out to specific instance ids (filter chips). */
  instanceIds?: string[] | null
}

/** Parse the instance's JSON-string filterReasons column defensively. */
export function parseFilterReasons(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string')
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((r): r is string => typeof r === 'string')
    } catch {
      // fall through — a legacy plain string
    }
    return [raw]
  }
  return []
}

/** Map one instance list row → QueueItem (NFR-X1 defensive). */
function mapRow(row: unknown, instance: ResolvedInstance): QueueItem | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string') return null

  const submitterRaw = r.submitter
  const submitter =
    submitterRaw && typeof submitterRaw === 'object'
      ? {
          username: typeof (submitterRaw as Record<string, unknown>).username === 'string' ? (submitterRaw as Record<string, unknown>).username as string : '',
          displayName:
            typeof (submitterRaw as Record<string, unknown>).displayName === 'string'
              ? ((submitterRaw as Record<string, unknown>).displayName as string)
              : null,
          profileImage:
            typeof (submitterRaw as Record<string, unknown>).profileImage === 'string'
              ? ((submitterRaw as Record<string, unknown>).profileImage as string)
              : null,
        }
      : { username: '', displayName: null, profileImage: null }

  const hasImage = typeof r.imageUrl === 'string' && r.imageUrl.length > 0
  const version =
    typeof r.imageSha256 === 'string' && r.imageSha256.length >= 10 ? r.imageSha256.slice(0, 10) : 'orig'

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    instanceColor: instance.colorTag,
    id: r.id,
    message: typeof r.message === 'string' ? r.message : '',
    status: typeof r.status === 'string' ? r.status : '',
    filterReasons: parseFilterReasons(r.filterReasons),
    nsfwStatus: typeof r.nsfwStatus === 'string' ? r.nsfwStatus : null,
    hasImage,
    imageUrl: hasImage ? `/api/controller/media/${instance.id}/${r.id}?v=${version}` : null,
    tweetId: typeof r.tweetId === 'string' ? r.tweetId : null,
    postError: typeof r.postError === 'string' ? r.postError : null,
    paidPost: r.paidPost === true,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    submitter,
  }
}

interface RawPagination {
  page?: unknown
  limit?: unknown
  total?: unknown
  totalPages?: unknown
  hasMore?: unknown
}

function readPagination(body: unknown): { items: unknown[]; total: number; hasMore: boolean } {
  if (!body || typeof body !== 'object') return { items: [], total: 0, hasMore: false }
  const b = body as Record<string, unknown>
  const items = Array.isArray(b.submissions) ? b.submissions : []
  const p = (b.pagination ?? {}) as RawPagination
  return {
    items,
    total: typeof p.total === 'number' && Number.isFinite(p.total) ? p.total : items.length,
    hasMore: p.hasMore === true,
  }
}

/** One status fetch against one instance. Never throws. */
async function fetchStatusPage(
  instance: ResolvedInstance,
  status: string,
  page: number,
  limit: number,
  search: string | null,
): Promise<{ items: QueueItem[]; total: number; hasMore: boolean; failure: InstanceHealth | null; error: string | null; retryAfterSec: number | null }> {
  const params = new URLSearchParams({ status, page: String(page), limit: String(limit) })
  if (search) params.set('search', search)

  const startedAt = Date.now()
  const call = await callInstance(
    { key: instance.id, baseUrl: instance.baseUrl, password: instance.password ?? '' },
    `/api/submissions?${params.toString()}`,
  )
  const ms = Date.now() - startedAt

  if (!call.ok) {
    controllerDebug('controller:queue', `instance=${instance.name} status=${status} ms=${ms} health=${call.kind}`)
    return { items: [], total: 0, hasMore: false, failure: call.kind, error: call.error, retryAfterSec: call.retryAfterSec }
  }
  controllerDebug('controller:queue', `instance=${instance.name} status=${status} ms=${ms} http=${call.status}`)

  if (call.status !== 200) {
    const errorBody = call.body as { error?: unknown } | null
    return {
      items: [],
      total: 0,
      hasMore: false,
      failure: 'down',
      error:
        typeof errorBody?.error === 'string' && errorBody.error
          ? errorBody.error
          : `Instance menjawab ${call.status}`,
      retryAfterSec: null,
    }
  }

  const { items, total, hasMore } = readPagination(call.body)
  const mapped = items
    .map((row) => mapRow(row, instance))
    .filter((item): item is QueueItem => item !== null)
  return { items: mapped, total, hasMore, failure: null, error: null, retryAfterSec: null }
}

/** Fan out the unified queue across all enabled instances. */
export async function fanOutQueue(params: QueueFanOutParams): Promise<QueueResponse> {
  const all = await loadResolvedInstances(true)
  const targets = params.instanceIds?.length
    ? all.filter((instance) => params.instanceIds?.includes(instance.id))
    : all

  const statuses = params.status === 'all' ? [...REVIEWABLE_STATUSES] : [params.status]
  const limit = Math.min(Math.max(params.limit, 1), QUEUE_PAGE_LIMIT)
  const fetchedAt = new Date().toISOString()

  const sections = await Promise.all(
    targets.map(async (instance): Promise<QueueSection> => {
      const base: QueueSection = {
        instanceId: instance.id,
        instanceName: instance.name,
        instanceColor: instance.colorTag,
        health: 'ok',
        error: null,
        retryAfterSec: null,
        items: [],
        page: params.page,
        hasMore: false,
        total: 0,
        lastFetchedAt: fetchedAt,
      }

      if (instance.credentialError || !instance.password) {
        return {
          ...base,
          health: 'auth-failed',
          error: instance.credentialError ?? 'Password instance belum tersimpan',
        }
      }

      const results = await Promise.all(
        statuses.map((status) => fetchStatusPage(instance, status, params.page, limit, params.search)),
      )

      // A failed status fetch degrades the whole section (frozen slice, FR-D11)
      const failure = results.find((result) => result.failure !== null)
      if (failure && failure.failure) {
        return {
          ...base,
          health: failure.failure,
          error: failure.error,
          retryAfterSec: failure.retryAfterSec,
        }
      }

      const seen = new Set<string>()
      const items: QueueItem[] = []
      for (const result of results) {
        for (const item of result.items) {
          if (seen.has(item.id)) continue
          seen.add(item.id)
          items.push(item)
        }
      }
      items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

      return {
        ...base,
        items,
        total: results.reduce((sum, result) => sum + result.total, 0),
        hasMore: results.some((result) => result.hasMore),
      }
    }),
  )

  return { sections, fetchedAt: fetchedAt }
}
