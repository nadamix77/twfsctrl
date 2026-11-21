'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BarChart3, Loader2, RefreshCw } from 'lucide-react'
import type { AnalyticsRange, AnalyticsSnapshot, InstanceDto } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { controllerFetch } from '@/hooks/use-controller-session'
import { formatIdr, formatIdrCompact } from '@/components/shared/format-idr'
import { cn } from '@/lib/core/utils'

// ============================================================
// analytics-panel.tsx — the Analitik (Statistik) view
//
// Range presets (Hari ini / 7 hari / 30 hari / Bulan ini) fan out
// to one analytics fetch PER instance card (the payload is heavy —
// never merged blindly across the fleet). The aggregate strip sums
// the loaded snapshots. Everything is read-only.
// ============================================================

interface AnalyticsPanelProps {
  instances: InstanceDto[]
  onUnauthorized: () => void
}

const RANGE_TABS: ReadonlyArray<{ value: AnalyticsRange; label: string }> = [
  { value: 'today', label: 'Hari ini' },
  { value: '7d', label: '7 hari' },
  { value: '30d', label: '30 hari' },
  { value: 'month', label: 'Bulan ini' },
]

/** Σ helpers over the daily series (nulls treated as 0). */
function sumDaily<T>(rows: T[], pick: (row: T) => number | null): number {
  return rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0)
}

export function AnalyticsPanel({ instances, onUnauthorized }: AnalyticsPanelProps) {
  const [range, setRange] = useState<AnalyticsRange>('30d')
  const [snapshots, setSnapshots] = useState<Map<string, AnalyticsSnapshot>>(new Map())
  const [reloadSignal, setReloadSignal] = useState(0)

  const enabledInstances = useMemo(() => instances.filter((i) => i.enabled), [instances])
  const instancesKey = useMemo(() => enabledInstances.map((i) => i.id).join(','), [enabledInstances])

  // Drop snapshots whose instance left the registry (render-time
  // adjustment — the use-countdown idiom).
  const [prunedKey, setPrunedKey] = useState<string | null>(null)
  if (prunedKey !== instancesKey) {
    setPrunedKey(instancesKey)
    if (snapshots.size > 0) {
      const ids = new Set(instancesKey.length > 0 ? instancesKey.split(',') : [])
      const next = new Map([...snapshots].filter(([id]) => ids.has(id)))
      if (next.size !== snapshots.size) setSnapshots(next)
    }
  }

  const handleData = useCallback((instanceId: string, snapshot: AnalyticsSnapshot | null) => {
    setSnapshots((prev) => {
      const next = new Map(prev)
      if (snapshot == null) next.delete(instanceId)
      else next.set(instanceId, snapshot)
      return next
    })
  }, [])

  const aggregate = useMemo(() => {
    if (snapshots.size === 0) return null
    let submissions = 0
    let posted = 0
    let revenue = 0
    let orders = 0
    let submitters = 0
    for (const snap of snapshots.values()) {
      submissions += sumDaily(snap.submissionsDaily, (r) => r.total)
      posted += sumDaily(snap.submissionsDaily, (r) => r.posted)
      revenue += sumDaily(snap.revenueDaily, (r) => r.revenueIdr)
      orders += sumDaily(snap.revenueDaily, (r) => r.orders)
      submitters += sumDaily(snap.submittersDaily, (r) => r.count)
    }
    return { submissions, posted, revenue, orders, submitters }
  }, [snapshots])

  return (
    <section aria-labelledby="analytics-title" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="analytics-title" className="text-base font-bold tracking-[-0.01em] text-ink">Analitik</h2>
          {aggregate != null && (
            <span
              className="inline-flex items-center rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-xs font-bold text-ink-2 [font-variant-numeric:tabular-nums]"
              aria-label={`${snapshots.size} instance termuat`}
            >
              {snapshots.size} instance
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          onClick={() => { setReloadSignal((n) => n + 1) }}
          aria-label="Muat ulang analitik"
          className="size-11 shrink-0 rounded-full p-0 text-ink-3 hover:text-ink"
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {/* Range presets */}
      <div
        role="group"
        aria-label="Rentang waktu"
        className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-line bg-cerah-surface-2 p-0.5"
      >
        {RANGE_TABS.map((tab) => {
          const active = range === tab.value
          return (
            <button
              type="button"
              key={tab.value}
              onClick={() => { setRange(tab.value) }}
              aria-pressed={active}
              className={cn(
                'flex min-h-9 shrink-0 cursor-pointer items-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Aggregate strip (fleet sum of loaded snapshots) */}
      {aggregate != null && snapshots.size > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-2xl border border-line bg-cerah-surface-2/60 px-3.5 py-2.5 text-xs">
          <span className="text-ink-2">
            Submission <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{aggregate.submissions}</span>
          </span>
          <span className="text-ink-2">
            Terkirim <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{aggregate.posted}</span>
          </span>
          <span className="text-ink-2">
            Order <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{aggregate.orders}</span>
          </span>
          <span className="text-ink-2">
            Pendapatan <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{formatIdrCompact(aggregate.revenue)}</span>
          </span>
          <span className="text-ink-2">
            Pengirim baru <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{aggregate.submitters}</span>
          </span>
        </div>
      )}

      {/* Per-instance cards */}
      {enabledInstances.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-10 text-center">
          <p className="m-0 text-sm font-semibold text-ink">Belum ada instance aktif</p>
          <p className="mt-1 text-xs text-ink-3">Analitik per instance muncul setelah instance didaftarkan.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {enabledInstances.map((instance) => (
            <InstanceAnalyticsCard
              key={instance.id}
              instance={instance}
              range={range}
              reloadSignal={reloadSignal}
              onUnauthorized={onUnauthorized}
              onData={handleData}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── One instance analytics card ─────────────────────────────

interface InstanceAnalyticsCardProps {
  instance: InstanceDto
  range: AnalyticsRange
  reloadSignal: number
  onUnauthorized: () => void
  onData: (instanceId: string, snapshot: AnalyticsSnapshot | null) => void
}

function StatTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-surface px-2 py-1.5">
      <span
        title={title ?? value}
        className="truncate text-sm font-bold leading-none text-ink [font-variant-numeric:tabular-nums]"
      >
        {value}
      </span>
      <span className="truncate text-[0.7rem] leading-tight text-ink-2" title={label}>{label}</span>
    </div>
  )
}

function InstanceAnalyticsCard({ instance, range, reloadSignal, onUnauthorized, onData }: InstanceAnalyticsCardProps) {
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const onUnauthorizedRef = useRef(onUnauthorized)
  useEffect(() => { onUnauthorizedRef.current = onUnauthorized }, [onUnauthorized])
  const onDataRef = useRef(onData)
  useEffect(() => { onDataRef.current = onData }, [onData])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const result = await controllerFetch<{ analytics: AnalyticsSnapshot }>(
        `/api/controller/analytics/${encodeURIComponent(instance.id)}?range=${range}`,
      )
      if (cancelled) return
      if (result.status === 401) {
        onUnauthorizedRef.current()
        return
      }
      if (result.ok && result.data != null) {
        setSnapshot(result.data.analytics)
        onDataRef.current(instance.id, result.data.analytics)
        setError(null)
      } else {
        setSnapshot(null)
        onDataRef.current(instance.id, null)
        setError(result.error)
      }
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [instance.id, range, reloadSignal])

  const totals = useMemo(() => {
    if (snapshot == null) return null
    return {
      submissions: sumDaily(snapshot.submissionsDaily, (r) => r.total),
      posted: sumDaily(snapshot.submissionsDaily, (r) => r.posted),
      notPassed: sumDaily(snapshot.submissionsDaily, (r) => r.notPassed),
      revenue: sumDaily(snapshot.revenueDaily, (r) => r.revenueIdr),
      orders: sumDaily(snapshot.revenueDaily, (r) => r.orders),
      submitters: sumDaily(snapshot.submittersDaily, (r) => r.count),
    }
  }, [snapshot])

  const funnel = snapshot?.funnel ?? null
  const packages = snapshot?.topupPackages ?? []
  const spenders = snapshot?.userLeaderboards?.spenders.slice(0, 3) ?? []
  const posters = snapshot?.userLeaderboards?.posters.slice(0, 3) ?? []
  const rejectionReasons = snapshot?.rejectionReasons.slice(0, 3) ?? []
  const failureClasses = snapshot?.failureClasses.slice(0, 3) ?? []

  return (
    <Card className="gap-0 py-0 [box-shadow:var(--shadow-sm)]">
      <CardContent className="flex flex-col gap-3 px-4 py-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full border border-line"
              style={instance.colorTag != null ? { backgroundColor: instance.colorTag } : { backgroundColor: 'var(--surface-3)' }}
              aria-hidden
            />
            <p className="m-0 truncate text-sm font-bold text-ink">{instance.name}</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-2">
            <BarChart3 className="size-3" aria-hidden />
            {snapshot?.windowDays != null ? `${snapshot.windowDays} hari` : '—'}
          </span>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex flex-col gap-2" aria-label="Memuat analitik">
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              {Array.from({ length: 6 }, (_, i) => <span key={i} className="cerah-skeleton h-12 rounded-lg" />)}
            </div>
            <span className="cerah-skeleton h-3 w-2/3 rounded-full" />
          </div>
        ) : error != null || snapshot == null || totals == null ? (
          <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Analitik tidak dapat dimuat: {error ?? 'instance tidak menjawab'}
          </p>
        ) : (
          <>
            {/* Totals — money tiles carry the exact figure in the title
                tooltip (the compact form rounds — house rule). */}
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              <StatTile label="Submission" value={String(totals.submissions)} />
              <StatTile label="Terkirim" value={String(totals.posted)} />
              <StatTile label="Tdk lolos" value={String(totals.notPassed)} />
              <StatTile label="Pendapatan" value={formatIdrCompact(totals.revenue).replace(/^Rp\s/, '')} title={formatIdr(totals.revenue)} />
              <StatTile label="Order" value={String(totals.orders)} />
              <StatTile label="Pengirim" value={String(totals.submitters)} />
            </div>

            {/* Funnel */}
            {funnel != null && (
              <p className="m-0 text-xs leading-relaxed text-ink-2 [font-variant-numeric:tabular-nums]">
                <span className="font-semibold text-ink">Funnel:</span>{' '}
                dibuat {funnel.created ?? '—'} · QR dilihat {funnel.qrViewed ?? '—'} · terbayar {funnel.paid ?? '—'}
                {funnel.latePaid != null && funnel.latePaid > 0 && ` (terlambat ${funnel.latePaid})`}
                {funnel.expired != null && funnel.expired > 0 && ` · kedaluwarsa ${funnel.expired}`}
                {funnel.voided != null && funnel.voided > 0 && ` · dibatalkan ${funnel.voided}`}
              </p>
            )}

            {/* Topup packages */}
            {packages.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="m-0 text-xs font-semibold text-ink">Paket top-up terlaris</p>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-ink-2 [font-variant-numeric:tabular-nums]">
                  {packages.slice(0, 3).map((pkg, i) => (
                    <li key={pkg.points != null ? String(pkg.points) : `pkg-${i}`}>
                      {pkg.points ?? '—'} poin · {pkg.orders ?? '—'} order ·{' '}
                      <span className="font-semibold text-ink">{pkg.revenueIdr != null ? formatIdr(pkg.revenueIdr) : '—'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Leaderboards */}
            {(spenders.length > 0 || posters.length > 0) && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {posters.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="m-0 text-xs font-semibold text-ink">Pengirim terbanyak</p>
                    <ol className="m-0 flex list-decimal list-inside flex-col gap-0.5 pl-0 text-xs text-ink-2 [font-variant-numeric:tabular-nums]">
                      {posters.map((poster) => (
                        <li key={poster.username}>
                          @{poster.username} — {poster.submissions ?? '—'}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {spenders.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="m-0 text-xs font-semibold text-ink">Pembayar terbesar</p>
                    <ol className="m-0 flex list-decimal list-inside flex-col gap-0.5 pl-0 text-xs text-ink-2 [font-variant-numeric:tabular-nums]">
                      {spenders.map((spender) => (
                        <li key={spender.username}>
                          @{spender.username} — {spender.totalIdr != null ? formatIdrCompact(spender.totalIdr) : '—'}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}

            {/* Rejection reasons + failure classes */}
            {(rejectionReasons.length > 0 || failureClasses.length > 0) && (
              <div className="flex flex-col gap-1 border-t border-line-soft pt-2 text-[0.7rem] leading-relaxed text-ink-3">
                {rejectionReasons.length > 0 && (
                  <p className="m-0">
                    Alasan ditolak: {rejectionReasons.map((r) => `${r.reason} ${r.count}`).join(' · ')}
                  </p>
                )}
                {failureClasses.length > 0 && (
                  <p className="m-0">
                    Kelas kegagalan: {failureClasses.map((f) => `${f.failureClass ?? 'tanpa kelas'} ${f.count}`).join(' · ')}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {loading && snapshot == null && (
          <p className="m-0 flex items-center gap-1.5 text-xs text-ink-3">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Memuat analitik {instance.name}…
          </p>
        )}
      </CardContent>
    </Card>
  )
}
