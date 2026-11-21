'use client'

import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  Coins,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import type {
  InstanceDto,
  PaymentOrder,
  PaymentsSection,
  PaymentStatusFilter,
  QuickActionResponse,
  UnmatchedCredit,
} from '@/lib/controller/types'
import { Badge } from '@/components/ui/badge'
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { controllerFetch } from '@/hooks/use-controller-session'
import { useInstanceSections } from '@/hooks/use-instance-sections'
import { formatIdr } from '@/components/shared/format-idr'
import { formatRelativeTime } from '@/lib/core/format'
import { cn } from '@/lib/core/utils'

// ============================================================
// payments-panel.tsx — the Pembayaran (Monetisasi) view
//
// Unified orders fan-out with status tabs + instance chips. Each
// section carries its revenue aggregates and GoBiz health; pending
// rows expose Konfirmasi (repair confirm — note wajib, refId
// opsional) and Batalkan (void); ambiguous credits resolve via
// Abaikan. All outcomes toast the instance's copy verbatim.
// ============================================================

interface PaymentsPanelProps {
  instances: InstanceDto[]
  onUnauthorized: () => void
}

const STATUS_TABS: ReadonlyArray<{ value: PaymentStatusFilter; label: string }> = [
  { value: 'all', label: 'Semua' },
  { value: 'pending', label: 'Menunggu' },
  { value: 'paid', label: 'Terbayar' },
  { value: 'expired', label: 'Kedaluwarsa' },
]

/** The dialog footer idiom (this repo's dialog.tsx ships no footer
 *  component — the instance-dialog classes are applied directly). */
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
}

function SkeletonRow() {
  return (
    <div className="rounded-2xl border border-line bg-surface px-3.5 py-3 [box-shadow:var(--shadow-sm)]">
      <div className="mb-2 flex items-center gap-2">
        <span className="cerah-skeleton h-3.5 w-20 rounded-full" />
        <span className="cerah-skeleton h-3.5 w-24 rounded-full" />
        <span className="cerah-skeleton ml-auto h-3.5 w-16 rounded-full" />
      </div>
      <div className="cerah-skeleton h-3 w-1/2 rounded-full" />
    </div>
  )
}

/** Status pill for an order. */
function OrderStatusBadge({ status }: { status: string }) {
  if (status === 'pending') {
    return (
      <Badge variant="outline" className="border-cerah-amber-line bg-cerah-amber-soft px-2 py-0.5 text-[10px] text-cerah-amber-strong">
        Menunggu
      </Badge>
    )
  }
  if (status === 'paid') {
    return (
      <Badge variant="outline" className="border-cerah-green-line bg-cerah-green-soft px-2 py-0.5 text-[10px] text-cerah-green">
        Terbayar
      </Badge>
    )
  }
  if (status === 'expired') {
    return (
      <Badge variant="outline" className="border-line bg-cerah-surface-2 px-2 py-0.5 text-[10px] text-ink-3">
        Kedaluwarsa
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-line bg-cerah-surface-2 px-2 py-0.5 text-[10px] text-ink-2">
      {status}
    </Badge>
  )
}

export function PaymentsPanel({ instances, onUnauthorized }: PaymentsPanelProps) {
  const { toast } = useToast()
  const [statusTab, setStatusTab] = useState<PaymentStatusFilter>('all')
  const [selectedInstances, setSelectedInstances] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const enabledInstances = useMemo(() => instances.filter((i) => i.enabled), [instances])
  const instancesKey = useMemo(() => enabledInstances.map((i) => i.id).join(','), [enabledInstances])

  const buildQuery = useCallback((page: number) => {
    const params = new URLSearchParams({ page: String(page) })
    if (statusTab !== 'all') params.set('status', statusTab)
    if (selectedInstances.length > 0) params.set('instances', selectedInstances.join(','))
    return params.toString()
  }, [statusTab, selectedInstances])

  const reloadKey = `${instancesKey}|${statusTab}|${selectedInstances.slice().sort().join(',')}`

  const list = useInstanceSections<PaymentOrder, PaymentsSection>({
    endpoint: '/api/controller/payments',
    buildQuery,
    reloadKey,
    getItems: (s) => s.orders,
    withItems: (s, orders) => ({ ...s, orders }),
    itemKey: (item) => `${item.instanceId}:${item.id}`,
    sortItems: (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
    onUnauthorized,
  })

  const toggleInstance = useCallback((instanceId: string) => {
    setSelectedInstances((prev) =>
      prev.includes(instanceId)
        ? prev.filter((id) => id !== instanceId)
        : [...prev, instanceId],
    )
  }, [])

  // ── Dialog state ─────────────────────────────────────
  const [confirmTarget, setConfirmTarget] = useState<PaymentOrder | null>(null)
  const [confirmNote, setConfirmNote] = useState('')
  const [confirmRefId, setConfirmRefId] = useState('')
  const [voidTarget, setVoidTarget] = useState<PaymentOrder | null>(null)
  const [dismissTarget, setDismissTarget] = useState<{ instanceId: string; instanceName: string; credit: UnmatchedCredit } | null>(null)

  const runAction = useCallback(async (
    action: 'confirm' | 'void' | 'dismiss',
    instanceId: string,
    body: Record<string, unknown>,
  ) => {
    if (busy) return null
    setBusy(true)
    const result = await controllerFetch<QuickActionResponse>(
      `/api/controller/payments/${encodeURIComponent(instanceId)}/${action}`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    setBusy(false)
    if (result.status === 401) {
      onUnauthorized()
      return null
    }
    const envelope = result.data
    if (result.ok && envelope != null && envelope.ok) {
      return envelope
    }
    toast({
      title: envelope?.error ?? result.error ?? 'Aksi gagal dijalankan',
      variant: 'destructive',
    })
    return null
  }, [busy, onUnauthorized, toast])

  const confirmPay = useCallback(async () => {
    if (confirmTarget == null) return
    const note = confirmNote.trim()
    if (note.length === 0) {
      toast({ title: 'Catatan wajib diisi', variant: 'destructive' })
      return
    }
    const body: Record<string, unknown> = { orderId: confirmTarget.id, note }
    const refId = confirmRefId.trim()
    if (refId.length > 0) body.refId = refId
    const envelope = await runAction('confirm', confirmTarget.instanceId, body)
    if (envelope != null) {
      const b = envelope.body as { latePayment?: unknown } | null
      toast({
        title: 'Order dikonfirmasi',
        description:
          b?.latePayment === true
            ? 'Pembayaran terlambat — ditandai late-payment'
            : 'Order ditandai terbayar (verifikasi admin)',
      })
      void list.refresh()
    }
    setConfirmTarget(null)
    setConfirmNote('')
    setConfirmRefId('')
  }, [confirmTarget, confirmNote, confirmRefId, runAction, list, toast])

  const voidOrder = useCallback(async () => {
    if (voidTarget == null) return
    const envelope = await runAction('void', voidTarget.instanceId, { orderId: voidTarget.id })
    if (envelope != null) {
      toast({ title: 'Order dibatalkan', description: 'Status order kini kedaluwarsa.' })
      void list.refresh()
    }
    setVoidTarget(null)
  }, [voidTarget, runAction, list, toast])

  const dismissAmbiguous = useCallback(async () => {
    if (dismissTarget == null) return
    const envelope = await runAction('dismiss', dismissTarget.instanceId, { refId: dismissTarget.credit.refId })
    if (envelope != null) {
      toast({ title: 'Hold ambigu diabaikan', description: dismissTarget.credit.refId })
      void list.refresh()
    }
    setDismissTarget(null)
  }, [dismissTarget, runAction, list, toast])

  // ── Derived view data ────────────────────────────────
  const degradedSections = useMemo(
    () => list.sections.filter((s) => s.health !== 'ok'),
    [list.sections],
  )
  const filtering = selectedInstances.length > 0

  return (
    <section aria-labelledby="payments-title" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="payments-title" className="text-base font-bold tracking-[-0.01em] text-ink">Pembayaran</h2>
          <span
            className="inline-flex min-w-6 items-center justify-center rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-xs font-bold text-ink-2 [font-variant-numeric:tabular-nums]"
            aria-label={`${list.total} order`}
          >
            {list.total}
          </span>
        </div>
        <Button
          variant="ghost"
          onClick={() => { void list.refresh() }}
          disabled={list.isRefreshing}
          aria-label="Muat ulang daftar pembayaran"
          className="size-11 shrink-0 rounded-full p-0 text-ink-3 hover:text-ink"
        >
          <RefreshCw className={cn('size-4', list.isRefreshing && 'animate-spin')} />
        </Button>
      </div>

      {/* Filters: status tabs + instance chips */}
      <div className="flex flex-col gap-1.5">
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
          <div
            role="group"
            aria-label="Filter status order"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-line bg-cerah-surface-2 p-0.5"
          >
            {STATUS_TABS.map((tab) => {
              const active = statusTab === tab.value
              return (
                <button
                  type="button"
                  key={tab.value}
                  onClick={() => { setStatusTab(tab.value) }}
                  aria-pressed={active}
                  className={cn(
                    'flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
                  )}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => { setSelectedInstances([]) }}
            aria-pressed={!filtering}
            className={cn(
              'inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !filtering
                ? 'border-ink bg-ink text-white'
                : 'border-line bg-surface text-ink-2 hover:bg-cerah-surface-2 hover:text-ink',
            )}
          >
            Semua instance
          </button>
          {enabledInstances.map((instance) => {
            const selected = selectedInstances.includes(instance.id)
            return (
              <button
                type="button"
                key={instance.id}
                onClick={() => { toggleInstance(instance.id) }}
                aria-pressed={selected}
                className={cn(
                  'inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'border-ink bg-ink text-white'
                    : 'border-line bg-surface text-ink-2 hover:bg-cerah-surface-2 hover:text-ink',
                )}
              >
                <span
                  className="size-2 rounded-full border border-line"
                  style={instance.colorTag != null ? { backgroundColor: instance.colorTag } : { backgroundColor: 'var(--surface-3)' }}
                  aria-hidden
                />
                {instance.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* Fetch error */}
      {list.error != null && (
        <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Gagal memuat daftar pembayaran: {list.error}
        </p>
      )}

      {/* Frozen sections (FR-D11) */}
      {degradedSections.map((section) => (
        <div
          key={section.instanceId}
          className={cn(
            'flex items-start gap-1.5 rounded-lg border px-3 py-2 text-xs leading-relaxed',
            section.health === 'down'
              ? 'border-cerah-red-line bg-cerah-red-soft text-cerah-red'
              : 'border-cerah-amber-line bg-cerah-amber-soft text-cerah-amber-strong',
          )}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p className="m-0">
            <strong>{section.instanceName}</strong> — data pembayaran tidak tersedia saat ini
            {section.error != null && section.error.length > 0 ? ` (${section.error})` : ''}
          </p>
        </div>
      ))}

      {/* The merged list */}
      {list.loading ? (
        <div className="flex flex-col gap-2.5" aria-label="Memuat daftar pembayaran">
          {Array.from({ length: 4 }, (_, i) => <SkeletonRow key={i} />)}
        </div>
      ) : list.flatItems.length === 0 && list.sections.every((s) => (s.gobiz?.ambiguous.length ?? 0) === 0) ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-10 text-center">
          <p className="m-0 text-sm font-semibold text-ink">
            {filtering ? 'Instance terpilih tidak punya order' : 'Tidak ada order'}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            Order pada filter status ini akan muncul di sini.
          </p>
        </div>
      ) : (
        <ul role="list" className="flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {list.sections.filter((s) => s.health === 'ok').flatMap((section) => {
              const rows: React.ReactNode[] = []

              // Section summary card
              rows.push(
                <li key={`${section.instanceId}-summary`} role="listitem" aria-label={`Ringkasan pembayaran ${section.instanceName}`}>
                  <SummaryCard section={section} />
                </li>,
              )

              // Order rows
              for (const order of section.orders) {
                rows.push(
                  <motion.li
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.18 }}
                    key={`${order.instanceId}:${order.id}`}
                    role="listitem"
                    aria-label={`Order ${order.id} oleh @${order.username} di ${order.instanceName}`}
                    className="rounded-2xl border border-line bg-surface [box-shadow:var(--shadow-sm)] transition-shadow hover:shadow-md"
                  >
                    <OrderRow
                      order={order}
                      busy={busy}
                      onConfirm={() => { setConfirmTarget(order); setConfirmNote(''); setConfirmRefId('') }}
                      onVoid={() => { setVoidTarget(order) }}
                    />
                  </motion.li>,
                )
              }

              // Ambiguous credits (resolve via dismiss)
              for (const credit of section.gobiz?.ambiguous ?? []) {
                rows.push(
                  <motion.li
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.18 }}
                    key={`${section.instanceId}:amb:${credit.refId}`}
                    role="listitem"
                    aria-label={`Kredit ambigu ${credit.refId} di ${section.instanceName}`}
                    className="rounded-2xl border border-cerah-amber-line bg-cerah-amber-soft px-3.5 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <TriangleAlert className="size-3.5 shrink-0 text-cerah-amber-strong" aria-hidden />
                          <span className="font-bold text-cerah-amber-strong">Kredit ambigu</span>
                          <span className="font-mono text-[0.7rem] text-ink-2">{credit.refId}</span>
                          {credit.amountIdr != null && (
                            <span className="font-semibold text-ink [font-variant-numeric:tabular-nums]">{formatIdr(credit.amountIdr)}</span>
                          )}
                          {credit.date != null && <span className="text-ink-3">· {formatRelativeTime(credit.date)}</span>}
                        </p>
                        <p className="m-0 mt-0.5 text-[0.7rem] leading-relaxed text-ink-2">
                          Jumlah transfer cocok dengan 2+ order menunggu di {section.instanceName} — konfirmasi manual dengan refId, atau abaikan bila bukan pembayaran.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => { setDismissTarget({ instanceId: section.instanceId, instanceName: section.instanceName, credit }) }}
                        className="h-9 shrink-0 px-3 text-xs"
                      >
                        Abaikan
                      </Button>
                    </div>
                  </motion.li>,
                )
              }

              // Orphan credits (display-only late payments)
              const orphans = section.gobiz?.orphans ?? []
              if (orphans.length > 0) {
                rows.push(
                  <li
                    key={`${section.instanceId}-orphans`}
                    role="listitem"
                    aria-label={`Kredit tanpa order di ${section.instanceName}`}
                    className="rounded-2xl border border-xblue-line bg-xblue-soft px-3.5 py-3"
                  >
                    <p className="m-0 text-xs font-bold text-xblue-ink">
                      Kredit masuk tanpa order ({orphans.length}) — pembayaran terlambat
                    </p>
                    <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                      {orphans.slice(0, 5).map((credit) => (
                        <li key={credit.refId} className="text-[0.7rem] text-ink-2">
                          <span className="font-mono">{credit.refId}</span>
                          {credit.amountIdr != null && ` · ${formatIdr(credit.amountIdr)}`}
                          {credit.date != null && ` · ${formatRelativeTime(credit.date)}`}
                        </li>
                      ))}
                    </ul>
                  </li>,
                )
              }

              return rows
            })}
          </AnimatePresence>
        </ul>
      )}

      {/* Pagination */}
      {list.hasMore && !list.loading && (
        <Button
          variant="outline"
          onClick={() => { void list.loadMore() }}
          disabled={list.loadingMore}
          className="self-center"
        >
          {list.loadingMore && <Loader2 className="size-4 animate-spin" />}
          {list.loadingMore ? 'Memuat…' : 'Muat lagi'}
        </Button>
      )}

      {/* Repair-confirm dialog (note mandatory) */}
      <Dialog open={confirmTarget != null} onOpenChange={(open) => { if (!open) { setConfirmTarget(null); setConfirmNote(''); setConfirmRefId('') } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Konfirmasi order secara manual?
              {confirmTarget != null && (
                <span className="text-ink-2"> — {confirmTarget.id.slice(0, 12)}… ({confirmTarget.instanceName})</span>
              )}
            </DialogTitle>
            <DialogDescription>
              Fallback untuk kegagalan GoBiz — pastikan dananya benar-benar sudah masuk. Order
              kedaluwarsa &lt; 24 jam masih boleh dikonfirmasi (ditandai late-payment).
            </DialogDescription>
          </DialogHeader>
          {confirmTarget != null && (
            <p className="m-0 rounded-lg border border-line bg-cerah-surface-2 px-3 py-2 text-xs text-ink-2">
              @{confirmTarget.username} · {confirmTarget.purpose === 'unblock' ? 'Buka blokir' : 'Top-up'}
              {confirmTarget.points != null && ` · ${confirmTarget.points} poin`}
              {confirmTarget.amountIdr != null && ` · ${formatIdr(confirmTarget.amountIdr)}`}
            </p>
          )}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pay-note" className="text-xs font-semibold text-ink-2">
                Catatan <span className="font-normal text-cerah-amber-strong">(wajib)</span>
              </label>
              <Textarea
                id="pay-note"
                value={confirmNote}
                onChange={(e) => { setConfirmNote(e.target.value) }}
                maxLength={300}
                rows={3}
                placeholder="mis. dana sudah masuk di GoBiz, poller error"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pay-refid" className="text-xs font-semibold text-ink-2">
                Referensi GoBiz (opsional)
              </label>
              <Input
                id="pay-refid"
                value={confirmRefId}
                onChange={(e) => { setConfirmRefId(e.target.value) }}
                maxLength={100}
                placeholder="gobiz:TXN123"
                className="font-mono text-xs"
              />
              <p className="m-0 text-[0.7rem] text-ink-3">
                Klaim kredit statement — sekaligus melepas hold ambigu dengan refId yang sama.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmTarget(null); setConfirmNote(''); setConfirmRefId('') }} disabled={busy}>
              Batal
            </Button>
            <Button
              className="bg-cerah-green text-white hover:bg-cerah-green-deep"
              onClick={() => { void confirmPay() }}
              disabled={busy}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              <BadgeCheck className="size-3.5" />
              Konfirmasi Terbayar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Void confirm */}
      <AlertDialog open={voidTarget != null} onOpenChange={(open) => { if (!open) setVoidTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Batalkan order ini?</AlertDialogTitle>
            <AlertDialogDescription>
              {voidTarget != null && (
                <>
                  Order @{voidTarget.username} ({voidTarget.id.slice(0, 12)}…,{' '}
                  {voidTarget.amountIdr != null ? formatIdr(voidTarget.amountIdr) : '—'}) di{' '}
                  {voidTarget.instanceName} diberhentikan lebih awal (kedaluwarsa). Untuk typo nominal
                  atau alur yang ditinggalkan — tidak memindahkan uang.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-cerah-red text-white hover:bg-cerah-red-strong"
              onClick={() => { void voidOrder() }}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Batalkan Order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Ambiguous dismiss confirm */}
      <AlertDialog open={dismissTarget != null} onOpenChange={(open) => { if (!open) setDismissTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Abaikan kredit ambigu ini?</AlertDialogTitle>
            <AlertDialogDescription>
              {dismissTarget != null && (
                <>
                  <span className="font-mono">{dismissTarget.credit.refId}</span> di{' '}
                  {dismissTarget.instanceName} ditandai bukan pembayaran nyata. Tindakan ini tidak
                  dapat dibatalkan — kompensasi tetap bisa lewat Sesuaikan Poin bila ternyata salah.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-ink text-white hover:bg-ink-hover"
              onClick={() => { void dismissAmbiguous() }}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Abaikan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

// ── Section summary card ────────────────────────────────────

function SummaryCard({ section }: { section: PaymentsSection }) {
  const gobiz = section.gobiz
  const gobizError = gobiz?.error != null
  return (
    <div className="rounded-2xl border border-line bg-cerah-surface-2/60 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="size-2.5 shrink-0 rounded-full border border-line"
            style={section.instanceColor != null ? { backgroundColor: section.instanceColor } : { backgroundColor: 'var(--surface-3)' }}
            aria-hidden
          />
          <span className="truncate text-sm font-bold text-ink">{section.instanceName}</span>
          <span className="text-xs text-ink-3 [font-variant-numeric:tabular-nums]">{section.total} order</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {section.revenue != null && (
            <>
              <span className="text-ink-2">
                Hari ini <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{section.revenue.todayIdr != null ? formatIdr(section.revenue.todayIdr) : '—'}</span>
              </span>
              <span className="text-ink-2">
                Total <span className="font-bold text-ink [font-variant-numeric:tabular-nums]">{section.revenue.totalIdr != null ? formatIdr(section.revenue.totalIdr) : '—'}</span>
              </span>
            </>
          )}
          {gobiz != null && (
            <Badge
              variant="outline"
              className={cn(
                'px-2 py-0.5 text-[10px]',
                gobizError
                  ? 'border-cerah-red-line bg-cerah-red-soft text-cerah-red'
                  : 'border-cerah-green-line bg-cerah-green-soft text-cerah-green',
              )}
            >
              GoBiz {gobizError ? 'error' : 'OK'}
            </Badge>
          )}
        </div>
      </div>
    </div>
  )
}

// ── One order row ───────────────────────────────────────────

interface OrderRowProps {
  order: PaymentOrder
  busy: boolean
  onConfirm: () => void
  onVoid: () => void
}

function OrderRow({ order, busy, onConfirm, onVoid }: OrderRowProps) {
  const isPending = order.status === 'pending'
  return (
    <div className="flex items-start justify-between gap-2 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        {/* Identity line */}
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-bold text-ink">@{order.username}</span>
          <Badge
            variant="outline"
            className={cn(
              'px-2 py-0.5 text-[10px]',
              order.purpose === 'unblock'
                ? 'border-cerah-amber-line bg-cerah-amber-soft text-cerah-amber-strong'
                : 'border-xblue-line bg-xblue-soft text-xblue-ink',
            )}
          >
            {order.purpose === 'unblock' ? <Ban className="size-2.5" /> : <Coins className="size-2.5" />}
            {order.purpose === 'unblock' ? 'Buka blokir' : 'Top-up'}
          </Badge>
          <OrderStatusBadge status={order.status} />
          {order.points != null && (
            <span className="text-xs text-ink-2 [font-variant-numeric:tabular-nums]">{order.points} poin</span>
          )}
          <span className="text-sm font-bold text-ink [font-variant-numeric:tabular-nums]">
            {order.amountIdr != null ? formatIdr(order.amountIdr) : '—'}
          </span>
        </div>

        {/* Meta line */}
        <p className="m-0 text-xs text-ink-3">
          {order.status === 'paid' && order.paidAt != null
            ? `dibayar ${formatRelativeTime(order.paidAt)}`
            : `dibuat ${formatRelativeTime(order.createdAt)}`}
          {order.expiresAt != null && order.status === 'pending' && ` · kedaluwarsa ${formatRelativeTime(order.expiresAt)}`}
          {order.verifiedBy != null && ` · verifikasi ${order.verifiedBy}`}
          {order.refId != null && ` · ${order.refId}`}
        </p>
      </div>

      {/* Actions — pending orders only */}
      {isPending && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onConfirm}
            disabled={busy}
            className="h-11 min-h-11 px-3 text-xs md:h-9 md:min-h-9"
          >
            Konfirmasi…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onVoid}
            disabled={busy}
            aria-label="Batalkan order"
            className="h-11 min-h-11 px-3 text-xs text-ink-3 hover:text-cerah-red md:h-9 md:min-h-9"
          >
            Batalkan
          </Button>
        </div>
      )}
    </div>
  )
}
