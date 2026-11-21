// ============================================================
// instance-admin.ts — Per-instance admin surfaces
//
// Server-side proxies for the per-instance features that don't
// fan out (they are inherently per-instance): scalar settings
// (Kredensial & X), filter settings, AI status/stats, and the
// analytics payload. Every read is defensively parsed (NFR-X1);
// every write returns the instance's status + body VERBATIM in a
// QuickActionResponse envelope (C4 doctrine).
// ============================================================

import { callInstance, type InstanceTarget } from './instance-client'
import type { ResolvedInstance } from './registry'
import {
  readBool,
  readInt,
  readIso,
  readNum,
  readNumBoolRecord,
  readNumRecord,
  readObjRecord,
  readStr,
  readStrArray,
} from './parse'
import type {
  AiSnapshot,
  AiStatsRow,
  AiStatusSnapshot,
  AnalyticsRange,
  AnalyticsSnapshot,
  FilterSettingsSnapshot,
  QuickActionResponse,
  SettingRow,
  SettingsSnapshot,
} from './types'

function targetOf(instance: ResolvedInstance): InstanceTarget {
  return { key: instance.id, baseUrl: instance.baseUrl, password: instance.password ?? '' }
}

function actionError(call: { ok: false; error: string; status: number }): QuickActionResponse {
  return { ok: false, status: call.status, body: null, error: call.error }
}

function passthrough(call: Awaited<ReturnType<typeof callInstance>>): QuickActionResponse {
  if (!call.ok) return actionError(call)
  const errorBody = call.body as { error?: unknown } | null
  const errorText =
    call.status >= 400 && typeof errorBody?.error === 'string' && errorBody.error ? errorBody.error : null
  return { ok: call.status >= 200 && call.status < 300, status: call.status, body: call.body, error: errorText }
}

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

// ── Scalar settings (Kredensial & X) ───────────────────────

export function parseSettingsSnapshot(body: unknown): SettingsSnapshot | null {
  if (body == null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const rows = Array.isArray(b.settings) ? b.settings : []
  const settings: SettingRow[] = []
  for (const row of rows) {
    if (row == null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const key = readStr(r.key)
    if (key == null) continue
    settings.push({
      key,
      value: typeof r.value === 'string' ? r.value : '***',
      updatedAt: readIso(r.updatedAt),
    })
  }
  return { settings, encryptionEnabled: readBool(b.encryptionEnabled) }
}

/** GET /api/admin/settings → masked rows (values never leave the
 *  instance unmasked; the controller stores nothing). */
export async function fetchSettingsSnapshot(instance: ResolvedInstance): Promise<SettingsSnapshot | null> {
  const call = await callInstance(targetOf(instance), '/api/admin/settings')
  if (!call.ok || call.status !== 200) return null
  return parseSettingsSnapshot(call.body)
}

/** POST /api/admin/settings {key, value} — upsert one key. */
export async function saveInstanceSetting(
  instance: ResolvedInstance,
  key: string,
  value: string,
): Promise<QuickActionResponse> {
  return passthrough(await callInstance(targetOf(instance), '/api/admin/settings', jsonInit({ key, value })))
}

/** DELETE /api/admin/settings?key= — remove one key. */
export async function deleteInstanceSetting(instance: ResolvedInstance, key: string): Promise<QuickActionResponse> {
  return passthrough(
    await callInstance(
      targetOf(instance),
      `/api/admin/settings?key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),
  )
}

// ── Filter settings ─────────────────────────────────────────

export function parseFilterSettings(body: unknown): FilterSettingsSnapshot | null {
  if (body == null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const guidelinesRaw = b.postingGuidelines != null && typeof b.postingGuidelines === 'object'
    ? b.postingGuidelines as Record<string, unknown>
    : null
  return {
    autoApprove: readBool(b.autoApprove),
    blockedWords: readStrArray(b.blockedWords),
    nsfwWords: readStrArray(b.nsfwWords),
    filterRules: readObjRecord(b.filterRules),
    aiEnabled: readBool(b.aiEnabled),
    aiApiKeySet: readBool(b.aiApiKeySet),
    aiSystemPrompt: readStr(b.aiSystemPrompt),
    aiImageSystemPrompt: readStr(b.aiImageSystemPrompt),
    rateLimits: readNumRecord(b.rateLimits),
    circuitBreaker: readNumRecord(b.circuitBreaker),
    monetization: readNumBoolRecord(b.monetization),
    requireFollow: readBool(b.requireFollow),
    imagePostingMode: readStr(b.imagePostingMode),
    postingGuidelinesEnabled: readBool(b.postingGuidelinesEnabled),
    postingGuidelines: guidelinesRaw == null
      ? null
      : { allowed: readStrArray(guidelinesRaw.allowed), notAllowed: readStrArray(guidelinesRaw.notAllowed) },
    nsfwThresholds: readNumRecord(b.nsfwThresholds),
  }
}

/** GET /api/admin/filter-settings — the full parsed object. */
export async function fetchFilterSettings(instance: ResolvedInstance): Promise<FilterSettingsSnapshot | null> {
  const call = await callInstance(targetOf(instance), '/api/admin/filter-settings')
  if (!call.ok || call.status !== 200) return null
  return parseFilterSettings(call.body)
}

/** POST /api/admin/filter-settings — partial update; the patch is
 *  forwarded as-is (the instance validates groups + bounds). */
export async function saveFilterSettings(
  instance: ResolvedInstance,
  patch: Record<string, unknown>,
): Promise<QuickActionResponse> {
  return passthrough(
    await callInstance(targetOf(instance), '/api/admin/filter-settings', jsonInit(patch)),
  )
}

// ── AI status + stats ───────────────────────────────────────

function parseAiStatus(body: unknown): AiStatusSnapshot | null {
  if (body == null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const results = Array.isArray(b.results) ? b.results : []
  const providers: AiStatusSnapshot['providers'] = []
  for (const row of results) {
    if (row == null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    providers.push({
      id: readStr(r.id) ?? '',
      name: readStr(r.name),
      model: readStr(r.model),
      enabled: readBool(r.enabled),
      healthy: readBool(r.healthy),
      modelAvailable: r.modelAvailable == null ? null : r.modelAvailable === true,
      error: readStr(r.error),
      latencyMs: readInt(r.latencyMs),
    })
  }
  return {
    healthy: readBool(b.healthy),
    providers,
    encryptionEnabled: readBool(b.encryptionEnabled),
    error: readStr(b.error),
  }
}

function parseAiStats(body: unknown): AiSnapshot['stats'] | null {
  if (body == null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const rawRows = Array.isArray(b.rows) ? b.rows : []
  const rows: AiStatsRow[] = []
  for (const row of rawRows) {
    if (row == null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    rows.push({
      phase: readStr(r.phase) ?? '',
      provider: readStr(r.provider) ?? '',
      model: readStr(r.model),
      totalCalls: readInt(r.totalCalls) ?? 0,
      passCount: readInt(r.passCount) ?? 0,
      flagCount: readInt(r.flagCount) ?? 0,
      errorCount: readInt(r.errorCount) ?? 0,
      timeoutCount: readInt(r.timeoutCount) ?? 0,
      passRatePct: readNum(r.passRatePct),
      avgLatencyMs: readInt(r.avgLatencyMs),
      p50LatencyMs: readInt(r.p50LatencyMs),
      p95LatencyMs: readInt(r.p95LatencyMs),
      avgTotalTokens: readInt(r.avgTotalTokens),
      totalTokens: readInt(r.totalTokens),
    })
  }
  return {
    windowHours: readInt(b.windowHours),
    generatedAt: readIso(b.generatedAt),
    rows,
  }
}

/** GET /api/admin/ai-status + /api/admin/ai-stats in parallel —
 *  each may degrade independently (an old instance without the
 *  stats endpoint still serves its provider health). */
export async function fetchAiSnapshot(instance: ResolvedInstance): Promise<AiSnapshot> {
  const target = targetOf(instance)
  const [statusCall, statsCall] = await Promise.all([
    callInstance(target, '/api/admin/ai-status'),
    callInstance(target, '/api/admin/ai-stats'),
  ])

  return {
    status: statusCall.ok && statusCall.status === 200 ? parseAiStatus(statusCall.body) : null,
    statusError:
      statusCall.ok
        ? statusCall.status === 200 ? null : `Instance menjawab ${statusCall.status}`
        : statusCall.error,
    stats: statsCall.ok && statsCall.status === 200 ? parseAiStats(statsCall.body) : null,
    statsError:
      statsCall.ok
        ? statsCall.status === 200 ? null : `Instance menjawab ${statsCall.status}`
        : statsCall.error,
  }
}

// ── Analytics ───────────────────────────────────────────────

export function parseAnalytics(body: unknown): AnalyticsSnapshot | null {
  if (body == null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>

  // Daily series — literal per-series access (SAST idiom: no computed
  // member reads).
  const seriesOf = (raw: unknown): Array<Record<string, unknown>> =>
    Array.isArray(raw)
      ? (raw.filter((row) => row != null && typeof row === 'object') as Array<Record<string, unknown>>)
      : []
  const submissionsSeries = seriesOf(b.submissionsDaily)
  const revenueSeries = seriesOf(b.revenueDaily)
  const submittersSeries = seriesOf(b.submittersDaily)
  const pointsSeries = seriesOf(b.pointsDaily)

  const lbRaw = b.userLeaderboards != null && typeof b.userLeaderboards === 'object'
    ? b.userLeaderboards as Record<string, unknown>
    : null
  const lbRows = (rows: unknown): Array<Record<string, unknown>> =>
    Array.isArray(rows) ? (rows.filter((row) => row != null && typeof row === 'object') as Array<Record<string, unknown>>) : []

  const spendersRaw = lbRows(lbRaw?.spenders)
  const postersRaw = lbRows(lbRaw?.posters)

  const funnelRaw = b.funnel != null && typeof b.funnel === 'object' ? b.funnel as Record<string, unknown> : null

  return {
    windowDays: readInt(b.windowDays),
    generatedAt: readIso(b.generatedAt),
    submissionsDaily: submissionsSeries.map((r) => ({
      day: readStr(r.day) ?? '',
      total: readInt(r.total),
      posted: readInt(r.posted),
      notPassed: readInt(r.notPassed),
      inFlight: readInt(r.inFlight),
    })),
    revenueDaily: revenueSeries.map((r) => ({
      day: readStr(r.day) ?? '',
      orders: readInt(r.orders),
      revenueIdr: readInt(r.revenueIdr),
    })),
    submittersDaily: submittersSeries.map((r) => ({
      day: readStr(r.day) ?? '',
      count: readInt(r.count),
    })),
    pointsDaily: pointsSeries.map((r) => ({
      day: readStr(r.day) ?? '',
      granted: readInt(r.granted),
      spent: readInt(r.spent),
      refunded: readInt(r.refunded),
    })),
    failureClasses: (Array.isArray(b.failureClasses) ? b.failureClasses : [])
      .filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
      .map((r) => ({ failureClass: readStr(r.failureClass), count: readInt(r.count) ?? 0 })),
    rejectionReasons: (Array.isArray(b.rejectionReasons) ? b.rejectionReasons : [])
      .filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
      .map((r) => ({ reason: readStr(r.reason) ?? '', count: readInt(r.count) ?? 0 })),
    topupPackages: (Array.isArray(b.topupPackages) ? b.topupPackages : [])
      .filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
      .map((r) => ({ points: readInt(r.points), orders: readInt(r.orders), revenueIdr: readInt(r.revenueIdr) })),
    userLeaderboards: lbRaw == null
      ? null
      : {
          spenders: spendersRaw.map((r) => ({
            username: readStr(r.username) ?? '',
            totalIdr: readInt(r.totalIdr),
            orders: readInt(r.orders),
          })),
          posters: postersRaw.map((r) => ({
            username: readStr(r.username) ?? '',
            submissions: readInt(r.submissions),
          })),
        },
    funnel: funnelRaw == null
      ? null
      : {
          windowDays: readInt(funnelRaw.windowDays),
          pendingNow: readInt(funnelRaw.pendingNow),
          created: readInt(funnelRaw.created),
          resumed: readInt(funnelRaw.resumed),
          qrViewed: readInt(funnelRaw.qrViewed),
          paid: readInt(funnelRaw.paid),
          latePaid: readInt(funnelRaw.latePaid),
          expired: readInt(funnelRaw.expired),
          voided: readInt(funnelRaw.voided),
        },
  }
}

/** GET /api/admin/analytics?range= — one preset window. */
export async function fetchAnalytics(
  instance: ResolvedInstance,
  range: AnalyticsRange,
): Promise<{ analytics: AnalyticsSnapshot | null; error: string | null }> {
  const call = await callInstance(
    targetOf(instance),
    `/api/admin/analytics?range=${encodeURIComponent(range)}`,
  )
  if (!call.ok) return { analytics: null, error: call.error }
  if (call.status !== 200) {
    const errorBody = call.body as { error?: unknown } | null
    return {
      analytics: null,
      error:
        typeof errorBody?.error === 'string' && errorBody.error
          ? errorBody.error
          : `Instance menjawab ${call.status}`,
    }
  }
  return { analytics: parseAnalytics(call.body), error: null }
}
