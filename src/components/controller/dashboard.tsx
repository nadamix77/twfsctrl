'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BarChart3, LayoutGrid, Plus, Users, Wallet } from 'lucide-react'
import type { InstanceDto } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import { useControllerOverview } from '@/hooks/use-controller-overview'
import { controllerFetch } from '@/hooks/use-controller-session'
import { DashboardHeader } from './dashboard-header'
import { InstanceCard } from './instance-card'
import { InstanceDialog, type InstanceDialogTarget } from './instance-dialog'
import { DeleteInstanceDialog } from './delete-instance-dialog'
import { QueuePanel } from './queue-panel'
import { SubmittersPanel } from './submitters-panel'
import { PaymentsPanel } from './payments-panel'
import { AnalyticsPanel } from './analytics-panel'
import { InstanceSettingsDialog } from './instance-settings-dialog'
import { AuditDialog } from './audit-dialog'
import { cn } from '@/lib/core/utils'

// ============================================================
// dashboard.tsx — the composition root of the authenticated panel
//
// Sticky aggregate header → overview grid of instance cards → the
// unified moderation queue. Owns the registry list (filter chips +
// audit filter source) and every dialog's open state; registry and
// quick-action mutations funnel through afterRegistryChange() so
// overview, registry, and queue all re-read together.
// ============================================================

interface DashboardProps {
  onLogout: () => void
  /** Session re-check (fired when any API answers 401 mid-panel). */
  onSessionExpired: () => void
}

/** Top-level views — Ringkasan keeps the overview + queue; the other
 *  tabs are the ported Tweetfess admin surfaces (per-instance actions
 *  stay on their rows / the Pengaturan dialog). */
type PanelView = 'ringkasan' | 'pengirim' | 'pembayaran' | 'analitik'

const PANEL_VIEWS: ReadonlyArray<{ value: PanelView; label: string; icon: typeof LayoutGrid }> = [
  { value: 'ringkasan', label: 'Ringkasan', icon: LayoutGrid },
  { value: 'pengirim', label: 'Pengirim', icon: Users },
  { value: 'pembayaran', label: 'Pembayaran', icon: Wallet },
  { value: 'analitik', label: 'Analitik', icon: BarChart3 },
]

export function Dashboard({ onLogout, onSessionExpired }: DashboardProps) {
  const overview = useControllerOverview({ onUnauthorized: onSessionExpired })

  // ── Registry list ─────────────────────────────────────
  const [instances, setInstances] = useState<InstanceDto[]>([])
  const [registryError, setRegistryError] = useState<string | null>(null)

  const loadInstances = useCallback(async () => {
    const result = await controllerFetch<{ instances: InstanceDto[] }>('/api/controller/instances')
    if (result.status === 401) {
      onSessionExpired()
      return
    }
    if (result.ok && result.data != null) {
      setInstances(result.data.instances)
      setRegistryError(null)
    } else {
      setRegistryError(result.error)
    }
  }, [onSessionExpired])

  // Mount fetch through the ref indirection (the admin-stats-context
  // idiom) so the effect always calls the latest loader.
  const loadInstancesRef = useRef(loadInstances)
  useEffect(() => { loadInstancesRef.current = loadInstances }, [loadInstances])
  useEffect(() => { void loadInstancesRef.current() }, [])

  /** Fan-out refresh after ANY registry mutation or quick action:
   *  overview cards, registry list, and the queue all re-read. */
  const [reloadSignal, setReloadSignal] = useState(0)
  const afterRegistryChange = useCallback(() => {
    void loadInstances()
    void overview.refresh()
    setReloadSignal((n) => n + 1)
  }, [loadInstances, overview])

  // ── Dialog state ──────────────────────────────────────
  const [instanceDialogOpen, setInstanceDialogOpen] = useState(false)
  const [instanceDialogTarget, setInstanceDialogTarget] = useState<InstanceDialogTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<InstanceDto | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [settingsTarget, setSettingsTarget] = useState<InstanceDto | null>(null)

  // Active view (the ported Tweetfess surfaces)
  const [view, setView] = useState<PanelView>('ringkasan')

  const openCreate = useCallback(() => {
    setInstanceDialogTarget({ mode: 'create' })
    setInstanceDialogOpen(true)
  }, [])
  const openEdit = useCallback((instance: InstanceDto, focusPassword: boolean) => {
    setInstanceDialogTarget({ mode: 'edit', instance, focusPassword })
    setInstanceDialogOpen(true)
  }, [])

  const cards = overview.data?.instances ?? null
  const overviewFirstLoading = overview.data == null && overview.error == null

  return (
    <>
      <DashboardHeader
        data={overview.data}
        isRefreshing={overview.isRefreshing}
        onRefresh={() => { void overview.refresh() }}
        onOpenAudit={() => { setAuditOpen(true) }}
        onLogout={onLogout}
      />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
        {/* View tabs — the ported Tweetfess surfaces (Pengirim /
            Pembayaran / Analitik) + the original Ringkasan. The wrapper
            scrolls on narrow screens (the queue status-tabs idiom). */}
        <nav aria-label="Bagian panel" className="-mx-1 overflow-x-auto px-1 pb-0.5">
          <div
            role="group"
            aria-label="Pilih bagian"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-cerah-surface-2 p-0.5"
          >
            {PANEL_VIEWS.map((panel) => {
              const active = view === panel.value
              return (
                <button
                  type="button"
                  key={panel.value}
                  onClick={() => { setView(panel.value) }}
                  aria-pressed={active}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
                  )}
                >
                  <panel.icon className="size-3.5" aria-hidden />
                  {panel.label}
                </button>
              )
            })}
          </div>
        </nav>

        {/* Stale-data banner — the fan-out failed but the last payload stays */}
        {view === 'ringkasan' && overview.error != null && (
          <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Gagal memuat ringkasan: {overview.error}
            {overview.data != null ? ' — menampilkan data terakhir.' : ''}
          </p>
        )}
        {view !== 'ringkasan' && registryError != null && (
          <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Gagal memuat daftar instance: {registryError}
          </p>
        )}

        {view === 'ringkasan' && (
          <>
            {/* ── Overview grid (Epic C) ── */}
        <section aria-labelledby="instances-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 id="instances-title" className="text-base font-bold tracking-[-0.01em] text-ink">Instance</h2>
              {cards != null && (
                <span
                  className="inline-flex min-w-6 items-center justify-center rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-xs font-bold text-ink-2 [font-variant-numeric:tabular-nums]"
                  aria-label={`${cards.length} instance`}
                >
                  {cards.length}
                </span>
              )}
            </div>
            <Button onClick={openCreate} size="sm" className="h-11 md:h-9 md:min-h-9">
              <Plus className="size-4" />
              Tambah Instance
            </Button>
          </div>

          {overviewFirstLoading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 [box-shadow:var(--shadow-sm)]">
                  <div className="cerah-skeleton h-4 w-1/2 rounded-full" />
                  <div className="cerah-skeleton h-9 w-24 rounded-lg" />
                  <div className="cerah-skeleton h-3 w-full rounded-full" />
                  <div className="cerah-skeleton h-3 w-2/3 rounded-full" />
                </div>
              ))}
            </div>
          ) : cards != null && cards.length === 0 ? (
            // First-run empty state (§11.1)
            <div className="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-12 text-center">
              <p className="m-0 text-sm font-semibold text-ink">Belum ada instance terdaftar</p>
              <p className="mt-1 text-xs text-ink-3">
                Tambahkan deployment Tweetfess pertama untuk mulai memonitor dari satu panel.
              </p>
              <Button onClick={openCreate} className="mt-4">
                <Plus className="size-4" />
                Tambah Instance
              </Button>
            </div>
          ) : cards != null ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {cards.map((card) => (
                <InstanceCard
                  key={card.instance.id}
                  overview={card}
                  onChanged={afterRegistryChange}
                  onEdit={openEdit}
                  onSettings={(target) => { setSettingsTarget(target) }}
                  onDelete={(instance) => {
                    setDeleteTarget(instance)
                    setDeleteOpen(true)
                  }}
                />
              ))}
            </div>
          ) : null}
        </section>

        {/* ── Unified queue (Epic D) ── */}
        <QueuePanel instances={instances} onUnauthorized={onSessionExpired} reloadSignal={reloadSignal} />
          </>
        )}

        {view === 'pengirim' && (
          <SubmittersPanel instances={instances} onUnauthorized={onSessionExpired} />
        )}
        {view === 'pembayaran' && (
          <PaymentsPanel instances={instances} onUnauthorized={onSessionExpired} />
        )}
        {view === 'analitik' && (
          <AnalyticsPanel instances={instances} onUnauthorized={onSessionExpired} />
        )}
      </main>

      {/* ── Dialogs (state lifted here) ── */}
      <InstanceDialog
        open={instanceDialogOpen}
        onOpenChange={setInstanceDialogOpen}
        target={instanceDialogTarget}
        onSaved={afterRegistryChange}
      />
      <DeleteInstanceDialog
        instance={deleteTarget}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={afterRegistryChange}
      />
      <InstanceSettingsDialog
        instance={settingsTarget}
        open={settingsTarget != null}
        onOpenChange={(open) => { if (!open) setSettingsTarget(null) }}
        onUnauthorized={onSessionExpired}
      />
      <AuditDialog open={auditOpen} onOpenChange={setAuditOpen} instances={instances} />
    </>
  )
}
