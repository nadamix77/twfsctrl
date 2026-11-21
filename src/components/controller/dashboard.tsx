'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import type { InstanceDto } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import { useControllerOverview } from '@/hooks/use-controller-overview'
import { controllerFetch } from '@/hooks/use-controller-session'
import { DashboardHeader } from './dashboard-header'
import { InstanceCard } from './instance-card'
import { InstanceDialog, type InstanceDialogTarget } from './instance-dialog'
import { DeleteInstanceDialog } from './delete-instance-dialog'
import { QueuePanel } from './queue-panel'
import { AuditDialog } from './audit-dialog'

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
        {/* Stale-data banner — the fan-out failed but the last payload stays */}
        {overview.error != null && (
          <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Gagal memuat ringkasan: {overview.error}
            {overview.data != null ? ' — menampilkan data terakhir.' : ''}
          </p>
        )}
        {registryError != null && (
          <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Gagal memuat daftar instance: {registryError}
          </p>
        )}

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
      <AuditDialog open={auditOpen} onOpenChange={setAuditOpen} instances={instances} />
    </>
  )
}
