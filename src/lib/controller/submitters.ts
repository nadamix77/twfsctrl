// ============================================================
// submitters.ts — Unified submitters (Pengirim) fan-out
//
// Merged list of submitters from every ENABLED instance, mirroring
// the queue fan-out doctrine (queue.ts): per-instance sections, a
// degraded instance freezes its OWN slice only, and one parallel
// filter-settings call per instance supplies the ID lists the
// blocked/whitelisted/imageAllowed flags are derived from. When
// that cross-reference fails the section still serves its rows —
// flagsKnown goes false and the flags render as unknown.
//
// Actions (block / unblock / whitelist / image allowlist /
// overrides / points-adjust) are thin translations to the
// instance's dedicated routes; the instance's JSON body passes
// through VERBATIM (C4 doctrine).
// ============================================================

import { callInstance, type InstanceTarget } from './instance-client'
import { loadResolvedInstances, type ResolvedInstance } from './registry'
import { controllerDebug } from './log'
import { readInt, readIso, readNumRecord, readPagination, readStr, readStrArray } from './parse'
import type {
  QuickActionResponse,
  SubmittersResponse,
  SubmittersSection,
  SubmitterAction,
  SubmitterItem,
} from './types'

export const SUBMITTERS_PAGE_LIMIT = 50

export interface SubmittersFanOutParams {
  page: number
  search: string | null
  /** Restrict fan-out to specific instance ids (filter chips). */
  instanceIds?: string[] | null
}

function targetOf(instance: ResolvedInstance): InstanceTarget {
  return { key: instance.id, baseUrl: instance.baseUrl, password: instance.password ?? '' }
}

/** The three filter-settings ID lists the row flags derive from. */
interface FlagLists {
  blocked: Set<string>
  whitelisted: Set<string>
  image: Set<string>
}

/** Map one instance submitters row → SubmitterItem (NFR-X1 defensive). */
function mapRow(row: unknown, instance: ResolvedInstance, lists: FlagLists): SubmitterItem | null {
  if (row == null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const username = readStr(r.username)
  if (username == null) return null

  const customLimits = readNumRecord(r.customLimits)
  const customPricing = readNumRecord(r.customPricing)
  const twitterId = typeof r.twitterId === 'string' ? r.twitterId : ''

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    instanceColor: instance.colorTag,
    id: typeof r.id === 'string' ? r.id : username,
    username,
    displayName: readStr(r.displayName),
    profileImage: readStr(r.profileImage),
    twitterId,
    customLimits,
    customPricing,
    createdAt: readIso(r.createdAt) ?? new Date(0).toISOString(),
    counts: {
      total: readInt(r.totalSubmissions) ?? 0,
      posted: readInt(r.posted) ?? 0,
      pending: readInt(r.pending) ?? 0,
      censored: readInt(r.censored) ?? 0,
      posting: readInt(r.posting) ?? 0,
      rejected: readInt(r.rejected) ?? 0,
      postFailed: readInt(r.postFailed) ?? 0,
    },
    blocked: twitterId.length > 0 ? lists.blocked.has(twitterId) : false,
    whitelisted: twitterId.length > 0 ? lists.whitelisted.has(twitterId) : false,
    imageAllowed: twitterId.length > 0 ? lists.image.has(twitterId) : false,
  }
}

/** Read the three ID lists out of a filter-settings body (any may be
 *  missing on an instance drift — the empty set degrades flags only). */
function readFilterIdLists(body: unknown): FlagLists | null {
  if (body == null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  return {
    blocked: new Set(readStrArray(b.blockedTwitterIds)),
    whitelisted: new Set(readStrArray(b.whitelistTwitterIds)),
    image: new Set(readStrArray(b.imagePostTwitterIds)),
  }
}

/** Fan out the submitters list across all enabled instances. */
export async function fanOutSubmitters(params: SubmittersFanOutParams): Promise<SubmittersResponse> {
  const all = await loadResolvedInstances(true)
  const targets = params.instanceIds?.length
    ? all.filter((instance) => params.instanceIds?.includes(instance.id))
    : all

  const fetchedAt = new Date().toISOString()

  const sections = await Promise.all(
    targets.map(async (instance): Promise<SubmittersSection> => {
      const base: SubmittersSection = {
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
        flagsKnown: false,
        lastFetchedAt: fetchedAt,
      }

      if (instance.credentialError || !instance.password) {
        return {
          ...base,
          health: 'auth-failed',
          error: instance.credentialError ?? 'Password instance belum tersimpan',
        }
      }

      const target = targetOf(instance)
      const query = new URLSearchParams({
        page: String(params.page),
        limit: String(SUBMITTERS_PAGE_LIMIT),
      })
      if (params.search) query.set('search', params.search)

      const startedAt = Date.now()
      const [listCall, filterCall] = await Promise.all([
        callInstance(target, `/api/admin/submitters?${query.toString()}`),
        // The ID lists are page-independent — only fetch them on page 1
        // (deeper pages reuse page-1 flags via the client-side merge).
        params.page === 1
          ? callInstance(target, '/api/admin/filter-settings')
          : Promise.resolve(null),
      ])
      const ms = Date.now() - startedAt

      if (!listCall.ok) {
        controllerDebug('controller:submitters', `instance=${instance.name} ms=${ms} health=${listCall.kind}`)
        return { ...base, health: listCall.kind, error: listCall.error, retryAfterSec: listCall.retryAfterSec }
      }
      controllerDebug('controller:submitters', `instance=${instance.name} ms=${ms} http=${listCall.status}`)

      if (listCall.status !== 200) {
        const errorBody = listCall.body as { error?: unknown } | null
        return {
          ...base,
          health: 'down',
          error:
            typeof errorBody?.error === 'string' && errorBody.error
              ? errorBody.error
              : `Instance menjawab ${listCall.status}`,
        }
      }

      const { items, total, hasMore } = readPagination(listCall.body, 'submitters')
      let idLists: FlagLists | null = null
      if (filterCall != null && filterCall.ok && filterCall.status === 200) {
        idLists = readFilterIdLists(filterCall.body)
      }
      const lists: FlagLists = idLists ?? {
        blocked: new Set<string>(),
        whitelisted: new Set<string>(),
        image: new Set<string>(),
      }
      const mapped = items
        .map((row) => mapRow(row, instance, lists))
        .filter((item): item is SubmitterItem => item !== null)

      return {
        ...base,
        items: mapped,
        total,
        hasMore,
        flagsKnown: idLists != null,
      }
    }),
  )

  return { sections, fetchedAt }
}

// ── Actions ─────────────────────────────────────────────────

export interface SubmitterActionPayload {
  username: string
  reason?: string | null
  delta?: number
  note?: string | null
  customLimits?: Record<string, number> | null
  customPricing?: Record<string, number> | null
}

/** Thin translation table: controller verb → instance HTTP call.
 *  The instance's status + body envelope passes through VERBATIM. */
export async function performSubmitterAction(
  instance: ResolvedInstance,
  action: SubmitterAction,
  payload: SubmitterActionPayload,
): Promise<QuickActionResponse> {
  const target = targetOf(instance)
  const jsonHeaders = { 'Content-Type': 'application/json' }

  let call: Awaited<ReturnType<typeof callInstance>>
  switch (action) {
    case 'block':
      call = await callInstance(target, '/api/admin/submitters/block', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          username: payload.username,
          ...(payload.reason != null && payload.reason.length > 0 ? { reason: payload.reason } : {}),
        }),
      })
      break
    case 'unblock':
      call = await callInstance(target, '/api/admin/submitters/unblock', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ username: payload.username }),
      })
      break
    case 'whitelist':
      call = await callInstance(target, '/api/admin/submitters/whitelist', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ username: payload.username }),
      })
      break
    case 'whitelist-remove':
      call = await callInstance(target, '/api/admin/submitters/whitelist', {
        method: 'DELETE',
        headers: jsonHeaders,
        body: JSON.stringify({ username: payload.username }),
      })
      break
    case 'image-allow':
      call = await callInstance(target, '/api/admin/submitters/image-post-allowlist', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ username: payload.username }),
      })
      break
    case 'image-deny':
      call = await callInstance(target, '/api/admin/submitters/image-post-allowlist', {
        method: 'DELETE',
        headers: jsonHeaders,
        body: JSON.stringify({ username: payload.username }),
      })
      break
    case 'overrides': {
      const body: Record<string, unknown> = { username: payload.username }
      if (payload.customLimits !== undefined) body.customLimits = payload.customLimits
      if (payload.customPricing !== undefined) body.customPricing = payload.customPricing
      call = await callInstance(target, '/api/admin/submitters/overrides', {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      })
      break
    }
    case 'points-adjust':
      call = await callInstance(target, '/api/admin/submitters/points-adjust', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          username: payload.username,
          delta: payload.delta,
          note: payload.note ?? '',
        }),
      })
      break
    default:
      return { ok: false, status: 0, body: null, error: 'Aksi tidak dikenal' }
  }

  if (!call.ok) {
    return { ok: false, status: call.status, body: null, error: call.error }
  }

  const errorBody = call.body as { error?: unknown } | null
  const errorText =
    call.status >= 400 && typeof errorBody?.error === 'string' && errorBody.error ? errorBody.error : null

  return { ok: call.status >= 200 && call.status < 300, status: call.status, body: call.body, error: errorText }
}

/** Defensive readers for the action bodies the UI toasts on. */
export function readSubmitterActionBody(body: unknown): {
  balance?: number | undefined
  blocked?: string | undefined
  unblocked?: string | undefined
  whitelisted?: string | undefined
  removed?: string | undefined
  added?: string | undefined
} {
  if (body == null || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  return {
    balance: readInt(b.balance) ?? undefined,
    blocked: readStr(b.blocked) ?? undefined,
    unblocked: readStr(b.unblocked) ?? undefined,
    whitelisted: readStr(b.whitelisted) ?? undefined,
    removed: readStr(b.removed) ?? undefined,
    added: readStr(b.added) ?? undefined,
  }
}
