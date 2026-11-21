// ============================================================
// overview.ts — Fan-out overview (Epic C, PRD B1 flow)
//
// One GET /api/admin/session per enabled instance, in parallel with
// an 8 s per-instance ceiling (Promise.allSettled semantics — one
// slow/dead instance never blocks the rest, NFR-R1/R2). Disabled
// instances render as 'disabled' cards WITHOUT any instance call
// (FR-B5). Nothing is persisted — every read is live.
// ============================================================

import { callInstance } from './instance-client'
import { loadResolvedInstances } from './registry'
import { controllerDebug } from './log'
import type { InstanceDto, InstanceOverview, InstanceStatsSnapshot, OverviewResponse } from './types'

type RawProvider = { enabled?: unknown; apiKeyCount?: unknown }

/** Defensive snapshot parse (NFR-X1): unknown fields ignored, every
 *  field nullable — an instance drift can never crash the merge. */
export function parseStatsSnapshot(body: unknown): InstanceStatsSnapshot | null {
  if (!body || typeof body !== 'object') return null
  const stats = (body as { stats?: unknown }).stats
  if (!stats || typeof stats !== 'object') return null
  const s = stats as Record<string, unknown>

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  const cbRaw = s.circuitBreaker
  let circuitBreaker: InstanceStatsSnapshot['circuitBreaker'] = null
  if (cbRaw && typeof cbRaw === 'object') {
    const cb = cbRaw as Record<string, unknown>
    circuitBreaker = {
      paused: cb.paused === true,
      remainingMinutes: num(cb.remainingMinutes) ?? 0,
      failCount: num(cb.failCount) ?? 0,
      threshold: num(cb.threshold) ?? 0,
      halfOpen: cb.halfOpen === true,
    }
  }

  const cookieRaw = s.cookieAuthStatus
  const cookieConfigured =
    cookieRaw && typeof cookieRaw === 'object'
      ? (cookieRaw as { configured?: unknown }).configured === true
      : null

  let aiEnabled: number | null = null
  let aiConfigured: number | null = null
  const fsRaw = s.filterSettings
  if (fsRaw && typeof fsRaw === 'object') {
    const providers = (fsRaw as { aiProviders?: unknown }).aiProviders
    if (Array.isArray(providers)) {
      aiConfigured = providers.length
      aiEnabled = providers.filter(
        (p: RawProvider) => p.enabled === true && typeof p.apiKeyCount === 'number' && p.apiKeyCount > 0,
      ).length
    }
  }

  return {
    pending: num(s.pending),
    censored: num(s.censored),
    posting: num(s.posting),
    postFailed: num(s.postFailed),
    rejected: num(s.rejected),
    posted: num(s.posted),
    total: num(s.total),
    circuitBreaker,
    cookieConfigured,
    aiEnabled,
    aiConfigured,
    revenueTodayIdr: num(s.revenueTodayIdr),
    revenueMonthIdr: num(s.revenueMonthIdr),
    submitters: num(s.submitters),
    postMethodSetting: typeof s.postMethodSetting === 'string' ? s.postMethodSetting : null,
    encryptionEnabled: typeof s.encryptionEnabled === 'boolean' ? s.encryptionEnabled : null,
    pendingPaymentsNow: num(s.pendingPaymentsNow),
    paymentsNeedingReview: num(s.paymentsNeedingReview),
  }
}

/** Fan out to one enabled instance. Never throws. */
async function fetchInstanceOverview(
  instance: Awaited<ReturnType<typeof loadResolvedInstances>>[number],
  dto: InstanceDto,
): Promise<InstanceOverview> {
  const startedAt = Date.now()
  const fetchedAt = new Date().toISOString()

  if (instance.credentialError) {
    return { instance: dto, health: 'auth-failed', stats: null, error: instance.credentialError, retryAfterSec: null, fetchedAt }
  }
  if (!instance.password) {
    return {
      instance: dto,
      health: 'auth-failed',
      stats: null,
      error: 'Password instance belum tersimpan — buka edit dan isi password',
      retryAfterSec: null,
      fetchedAt,
    }
  }

  const call = await callInstance(
    { key: instance.id, baseUrl: instance.baseUrl, password: instance.password },
    '/api/admin/session',
  )
  const ms = Date.now() - startedAt

  if (!call.ok) {
    controllerDebug('controller:fanout', `instance=${instance.name} ms=${ms} health=${call.kind}`)
    return { instance: dto, health: call.kind, stats: null, error: call.error, retryAfterSec: call.retryAfterSec, fetchedAt }
  }

  controllerDebug('controller:fanout', `instance=${instance.name} ms=${ms} status=${call.status}`)

  if (call.status !== 200) {
    const errorBody = call.body as { error?: unknown } | null
    return {
      instance: dto,
      health: 'down',
      stats: null,
      error:
        typeof errorBody?.error === 'string' && errorBody.error
          ? errorBody.error
          : `Instance menjawab ${call.status}`,
      retryAfterSec: null,
      fetchedAt,
    }
  }

  return {
    instance: dto,
    health: 'ok',
    stats: parseStatsSnapshot(call.body), // null → auth-only degrade (session route's catch arm)
    error: null,
    retryAfterSec: null,
    fetchedAt,
  }
}

/** Full fan-out: every registry row (enabled rows get live data,
 *  disabled rows render greyed — FR-B5/FR-C2). */
export async function fanOutOverview(): Promise<OverviewResponse> {
  const all = await loadResolvedInstances(false)
  const dtoPromises = Promise.all(
    all.map(async (instance) => ({
      instance,
      dto: {
        id: instance.id,
        name: instance.name,
        baseUrl: instance.baseUrl,
        handle: instance.handle,
        colorTag: instance.colorTag,
        enabled: instance.enabled,
        sortOrder: instance.sortOrder,
        createdAt: '', // filled below from the registry read
        updatedAt: '',
        hasCredential: instance.password != null || instance.credentialError != null,
      },
    })),
  )

  // Precise DTO rows (createdAt/updatedAt) from one registry read.
  const { listInstances } = await import('./registry')
  const dtoRows = await listInstances()
  const dtoById = new Map(dtoRows.map((row) => [row.id, row]))
  const pairs = await dtoPromises

  const cards = await Promise.all(
    pairs.map(async ({ instance, dto }) => {
      const precise = dtoById.get(instance.id)
      const cardDto = precise ?? dto
      if (!instance.enabled) {
        return {
          instance: cardDto,
          health: 'disabled' as const,
          stats: null,
          error: null,
          retryAfterSec: null,
          fetchedAt: new Date().toISOString(),
        }
      }
      return fetchInstanceOverview(instance, cardDto)
    }),
  )

  const aggregate = {
    totalPending: cards.reduce((sum, card) => sum + (card.stats?.pending ?? 0), 0),
    instancesUp: cards.filter((card) => card.health === 'ok').length,
    instancesEnabled: cards.filter((card) => card.health !== 'disabled').length,
    instancesTotal: cards.length,
    revenueTodayIdr: cards.reduce((sum, card) => sum + (card.stats?.revenueTodayIdr ?? 0), 0),
    submitters: cards.reduce((sum, card) => sum + (card.stats?.submitters ?? 0), 0),
  }

  return { instances: cards, aggregate, fetchedAt: new Date().toISOString() }
}
