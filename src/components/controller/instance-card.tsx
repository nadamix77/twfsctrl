'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Cookie,
  Eraser,
  ExternalLink,
  Loader2,
  MoreVertical,
  Pencil,
  Power,
  RotateCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import type { InstanceDto, InstanceOverview, InstanceQuickAction, QuickActionResponse } from '@/lib/controller/types'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCountdownFromSeconds } from '@/hooks/use-countdown'
import { useToast } from '@/hooks/use-toast'
import { controllerFetch } from '@/hooks/use-controller-session'
import { formatIdr } from '@/components/shared/format-idr'
import { formatMmSs, formatRelativeTime } from '@/lib/core/format'
import { cn } from '@/lib/core/utils'

// ============================================================
// instance-card.tsx — one fan-out card (FR-C1, §11.2)
//
// Health badge + prominent pending count + status tiles + money row
// + freshness footer with the card menu (admin deep link, edit,
// enable toggle, quick actions behind confirms, delete handoff).
// Data renders identically in every state — badges communicate
// freshness, not presence. Disabled cards grey out (FR-B5).
// ============================================================

interface InstanceCardProps {
  overview: InstanceOverview
  /** Refresh overview + registry after any mutation. */
  onChanged: () => void
  onEdit: (instance: InstanceDto, focusPassword: boolean) => void
  onDelete: (instance: InstanceDto) => void
}

/** Re-render on an interval so relative timestamps stay fresh
 *  (the "update 12 dtk lalu" footer). */
function useTick(intervalMs: number): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => { setTick((t) => t + 1) }, intervalMs)
    return () => { clearInterval(id) }
  }, [intervalMs])
}

const QUICK_ACTIONS: ReadonlyArray<{
  action: InstanceQuickAction
  label: string
  icon: typeof Zap
  title: string
  description: string
  confirmCls: string
}> = [
  {
    action: 'breaker-reset',
    label: 'Reset Circuit Breaker',
    icon: Zap,
    title: 'Reset circuit breaker instance ini?',
    description: 'Circuit breaker dibuka kembali dan percobaan posting ke X dilanjutkan.',
    confirmCls: 'bg-cerah-green hover:bg-cerah-green-deep text-white',
  },
  {
    action: 'clear-cache',
    label: 'Bersihkan Cache',
    icon: Eraser,
    title: 'Bersihkan cache instance ini?',
    description: 'Cache token dan sesi di instance akan dibersihkan.',
    confirmCls: 'bg-cerah-green hover:bg-cerah-green-deep text-white',
  },
  {
    action: 'requeue',
    label: 'Requeue Gagal Posting',
    icon: RotateCcw,
    title: 'Requeue pesan gagal posting?',
    description: 'Semua pesan gagal posting di instance ini dikembalikan ke antrean posting.',
    confirmCls: 'bg-ink hover:bg-ink-hover text-white',
  },
]

interface QuickBody {
  message?: string | undefined
  requeued?: number | undefined
}

/** Defensive read of the verbatim instance body (NFR-X1). */
function readQuickBody(body: unknown): QuickBody {
  if (body == null || typeof body !== 'object') return {}
  const b = body as { message?: unknown; requeued?: unknown }
  return {
    message: typeof b.message === 'string' ? b.message : undefined,
    requeued: typeof b.requeued === 'number' ? b.requeued : undefined,
  }
}

function HealthBadge({ overview, lockedOutRemaining }: { overview: InstanceOverview; lockedOutRemaining: number }) {
  switch (overview.health) {
    case 'ok':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cerah-green-line bg-cerah-green-soft px-2 py-0.5 text-xs font-semibold text-cerah-green">
          <span className="size-1.5 rounded-full bg-cerah-green-strong" aria-hidden />
          Sehat
        </span>
      )
    case 'auth-failed':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cerah-amber-line bg-cerah-amber-soft px-2 py-0.5 text-xs font-semibold text-cerah-amber-strong">
          <AlertTriangle className="size-3" aria-hidden />
          Auth gagal
        </span>
      )
    case 'locked-out':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cerah-amber-line bg-cerah-amber-soft px-2 py-0.5 text-xs font-semibold text-cerah-amber-strong [font-variant-numeric:tabular-nums]">
          <span className="size-1.5 animate-softpulse rounded-full bg-cerah-amber-strong" aria-hidden />
          Terkunci {lockedOutRemaining > 0 ? formatMmSs(lockedOutRemaining) : ''}
        </span>
      )
    case 'down':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cerah-red-line bg-cerah-red-soft px-2 py-0.5 text-xs font-semibold text-cerah-red">
          <span className="size-1.5 rounded-full bg-cerah-red-strong" aria-hidden />
          Tidak terjangkau
        </span>
      )
    case 'disabled':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-2">
          nonaktif
        </span>
      )
  }
}

/** One small stat tile in the counts row (null → "—"). */
function CountTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface px-2 py-1.5">
      <span className="text-sm font-bold leading-none text-ink [font-variant-numeric:tabular-nums]">
        {value ?? '—'}
      </span>
      <span className="text-[0.7rem] leading-tight text-ink-2">{label}</span>
    </div>
  )
}

export function InstanceCard({ overview, onChanged, onEdit, onDelete }: InstanceCardProps) {
  const { instance, stats } = overview
  const { toast } = useToast()
  const [pendingQuick, setPendingQuick] = useState<InstanceQuickAction | null>(null)
  const [busy, setBusy] = useState(false)
  const lockedOutRemaining = useCountdownFromSeconds(
    overview.health === 'locked-out' ? (overview.retryAfterSec ?? 0) : 0,
  )
  useTick(15_000)

  const runQuickAction = async (action: InstanceQuickAction) => {
    if (busy) return
    setBusy(true)
    const result = await controllerFetch<QuickActionResponse>(
      `/api/controller/instances/${encodeURIComponent(instance.id)}/actions`,
      { method: 'POST', body: JSON.stringify({ action }) },
    )
    setBusy(false)
    setPendingQuick(null)
    const envelope = result.data
    if (result.ok && envelope != null && envelope.ok) {
      const body = readQuickBody(envelope.body)
      toast({
        title: body.message ?? 'Aksi berhasil dijalankan',
        ...(body.requeued != null ? { description: `${body.requeued} pesan dikembalikan ke antrean posting` } : {}),
      })
      onChanged()
    } else {
      toast({
        title: envelope?.error ?? result.error ?? 'Aksi gagal dijalankan',
        variant: 'destructive',
      })
    }
  }

  const toggleEnabled = async () => {
    if (busy) return
    setBusy(true)
    const result = await controllerFetch<{ instance: InstanceDto }>(
      `/api/controller/instances/${encodeURIComponent(instance.id)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled: !instance.enabled }) },
    )
    setBusy(false)
    if (result.ok) {
      toast({ title: instance.enabled ? 'Instance dinonaktifkan' : 'Instance diaktifkan' })
      onChanged()
    } else {
      toast({ title: result.error ?? 'Gagal mengubah status instance', variant: 'destructive' })
    }
  }

  const cb = stats?.circuitBreaker ?? null

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
      className={cn(!instance.enabled && 'opacity-60')}
    >
      <Card className="gap-0 py-0 [box-shadow:var(--shadow-sm)]">
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          {/* Header: color dot, name + handle, health badge */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="size-3 shrink-0 rounded-full border border-line"
                style={instance.colorTag != null ? { backgroundColor: instance.colorTag } : { backgroundColor: 'var(--surface-3)' }}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold leading-tight text-ink">{instance.name}</p>
                {instance.handle != null && instance.handle.length > 0 && (
                  <p className="truncate text-xs leading-tight text-ink-3">@{instance.handle}</p>
                )}
              </div>
            </div>
            <HealthBadge overview={overview} lockedOutRemaining={lockedOutRemaining} />
          </div>

          {/* Degrade detail lines (verbatim error text) */}
          {overview.health === 'down' && overview.error != null && (
            <p className="m-0 line-clamp-2 rounded-md border border-cerah-red-line bg-cerah-red-soft px-2.5 py-1.5 text-xs leading-relaxed break-words text-cerah-red">
              {overview.error}
            </p>
          )}
          {overview.health === 'auth-failed' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-cerah-amber-line bg-cerah-amber-soft px-2.5 py-1.5">
              <p className="m-0 line-clamp-2 text-xs leading-relaxed text-cerah-amber-strong">
                {overview.error ?? 'Password instance ditolak — perbarui password-nya.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0 px-3 text-xs"
                onClick={() => { onEdit(instance, true) }}
              >
                Perbarui Password
              </Button>
            </div>
          )}

          {/* Prominent pending count */}
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold leading-none tracking-[-0.02em] text-ink [font-variant-numeric:tabular-nums]">
              {stats?.pending ?? '—'}
            </span>
            <span className="text-xs font-medium text-ink-2">menunggu review</span>
          </div>

          {stats === null && overview.health === 'ok' && (
            <p className="m-0 text-xs text-ink-3">Data statistik tidak tersedia (instance versi lama?)</p>
          )}

          {/* Counts row */}
          {stats != null && (
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              <CountTile label="Disensor" value={stats.censored} />
              <CountTile label="Posting" value={stats.posting} />
              <CountTile label="Gagal" value={stats.postFailed} />
              <CountTile label="Ditolak" value={stats.rejected} />
              <CountTile label="Terkirim" value={stats.posted} />
              <CountTile label="Total" value={stats.total} />
            </div>
          )}

          {/* Status lines */}
          {stats != null && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {cb != null && (
                <li className="flex items-center gap-1.5 text-xs">
                  <Zap className={cn('size-3.5 shrink-0', cb.paused || cb.halfOpen ? 'text-cerah-amber-strong' : 'text-ink-3')} aria-hidden />
                  {cb.paused ? (
                    <span className="font-medium text-cerah-amber-strong">
                      CB dijeda — sisa {cb.remainingMinutes} mnt
                    </span>
                  ) : cb.halfOpen ? (
                    <span className="font-medium text-cerah-amber-strong">CB half-open</span>
                  ) : (
                    <span className="text-ink-3">CB normal</span>
                  )}
                </li>
              )}
              {stats.cookieConfigured != null && (
                <li className="flex items-center gap-1.5 text-xs">
                  <Cookie className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                  <span className={stats.cookieConfigured ? 'text-ink-2' : 'font-medium text-cerah-amber-strong'}>
                    Cookie X: {stats.cookieConfigured ? 'Terkonfigurasi' : 'Belum'}
                  </span>
                </li>
              )}
              {stats.aiEnabled != null && stats.aiConfigured != null && (
                <li className="flex items-center gap-1.5 text-xs">
                  <Sparkles className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                  <span className="text-ink-2">
                    {stats.aiEnabled === 0 ? 'AI nonaktif' : `AI: ${stats.aiEnabled}/${stats.aiConfigured} aktif`}
                  </span>
                </li>
              )}
              {stats.postMethodSetting != null && (
                <li className="flex items-center gap-1.5 text-xs">
                  <Route className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                  <span className="text-ink-2">Metode: {stats.postMethodSetting}</span>
                </li>
              )}
              {stats.encryptionEnabled != null && (
                <li className="flex items-center gap-1.5 text-xs">
                  {stats.encryptionEnabled ? (
                    <ShieldCheck className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                  ) : (
                    <ShieldAlert className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                  )}
                  <span className="text-ink-3">
                    {stats.encryptionEnabled ? 'Enkripsi aktif' : 'Enkripsi nonaktif'}
                  </span>
                </li>
              )}
            </ul>
          )}

          {/* Money row */}
          {stats != null && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-soft pt-2.5 text-xs">
              <span className="text-ink-2">
                Hari ini <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{stats.revenueTodayIdr != null ? formatIdr(stats.revenueTodayIdr) : '—'}</span>
              </span>
              <span className="text-ink-2">
                Bulan ini <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{stats.revenueMonthIdr != null ? formatIdr(stats.revenueMonthIdr) : '—'}</span>
              </span>
              {stats.submitters != null && (
                <span className="text-ink-2">
                  Pengirim <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{stats.submitters}</span>
                </span>
              )}
              {stats.pendingPaymentsNow != null && stats.pendingPaymentsNow > 0 && (
                <span className="font-semibold text-cerah-amber-strong [font-variant-numeric:tabular-nums]">
                  Pembayaran tertunda {stats.pendingPaymentsNow}
                </span>
              )}
            </div>
          )}

          {/* Footer: freshness + menu */}
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-xs text-ink-3">
              {busy && <Loader2 className="mr-1 inline size-3 animate-spin align-[-1px]" aria-hidden />}
              update {formatRelativeTime(overview.fetchedAt)}
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="size-9 rounded-full p-0 text-ink-3 hover:text-ink"
                  aria-label={`Menu instance ${instance.name}`}
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={`${instance.baseUrl}/admin`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    Buka Admin
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { onEdit(instance, false) }}>
                  <Pencil />
                  Edit Instance
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { void toggleEnabled() }} disabled={busy}>
                  <Power />
                  {instance.enabled ? 'Nonaktifkan' : 'Aktifkan'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {QUICK_ACTIONS.map((quick) => (
                  <DropdownMenuItem key={quick.action} onSelect={() => { setPendingQuick(quick.action) }} disabled={busy}>
                    <quick.icon />
                    {quick.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => { onDelete(instance) }}>
                  <Trash2 />
                  Hapus Instance
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardContent>
      </Card>

      {/* Quick-action confirms — one dialog, driven by pendingQuick. */}
      <AlertDialog open={pendingQuick != null} onOpenChange={(open) => { if (!open) setPendingQuick(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {QUICK_ACTIONS.find((q) => q.action === pendingQuick)?.title ?? ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {QUICK_ACTIONS.find((q) => q.action === pendingQuick)?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className={QUICK_ACTIONS.find((q) => q.action === pendingQuick)?.confirmCls}
              onClick={() => {
                if (pendingQuick != null) void runQuickAction(pendingQuick)
              }}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Lanjutkan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}
