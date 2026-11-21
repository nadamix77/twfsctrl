'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Ban,
  BadgeCheck,
  CheckCircle2,
  CircleDollarSign,
  ImageIcon,
  Loader2,
  MoreVertical,
  RefreshCw,
  SlidersHorizontal,
  UserCheck,
  UserX,
} from 'lucide-react'
import type { InstanceDto, QuickActionResponse, SubmitterAction, SubmitterItem, SubmittersSection } from '@/lib/controller/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SearchInput } from '@/components/ui/search-input'
import { MaskGlyph } from '@/components/shared/mask-glyph'
import { useToast } from '@/hooks/use-toast'
import { controllerFetch } from '@/hooks/use-controller-session'
import { useInstanceSections } from '@/hooks/use-instance-sections'
import { formatRelativeTime } from '@/lib/core/format'
import { cn } from '@/lib/core/utils'

// ============================================================
// submitters-panel.tsx — the Pengirim management view
//
// Unified submitters fan-out (sections per instance) with search +
// instance chips. Per-row actions mirror the instance's dedicated
// admin routes: blokir (auto-reject), whitelist, izin gambar,
// override limit & harga, sesuaikan poin. Every action toasts the
// instance's copy and refreshes the list (flags re-derive
// server-side from the filter-settings cross-reference).
// ============================================================

interface SubmittersPanelProps {
  instances: InstanceDto[]
  onUnauthorized: () => void
}

const SEARCH_DEBOUNCE_MS = 400

/** The dialog footer idiom (this repo's dialog.tsx ships no footer
 *  component — the instance-dialog classes are applied directly). */
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
}

/** Defensive reader for the verbatim instance body (NFR-X1). */
function readActionBody(body: unknown): { balance?: number | undefined } {
  if (body == null || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  return {
    balance: typeof b.balance === 'number' && Number.isFinite(b.balance) ? b.balance : undefined,
  }
}

/** SAST-clean dynamic lookup on an override record (entries-find, no
 *  computed member access). */
function lookupNum(record: Record<string, number> | null, key: string): number | null {
  if (record == null) return null
  const entry = Object.entries(record).find(([k]) => k === key)
  return entry != null && typeof entry[1] === 'number' ? entry[1] : null
}

/** Copy for the simple confirm actions (no extra inputs). */
const SIMPLE_ACTIONS = new Map<SubmitterAction, { title: string; description: string; confirm: string; confirmCls: string; success: string }>([
  ['unblock', {
    title: 'Buka blokir pengirim ini?',
    description: 'Pengirim dapat mengirim submission kembali dan alasan blokirnya dihapus.',
    confirm: 'Buka Blokir',
    confirmCls: 'bg-cerah-green text-white hover:bg-cerah-green-deep',
    success: 'Blokir dibuka',
  }],
  ['whitelist', {
    title: 'Tambahkan ke whitelist?',
    description: 'Pengirim melewati pemeriksaan eligibilitas, follow, dan batas per-pengguna. Blokir aktif (jika ada) dicabut.',
    confirm: 'Tambahkan',
    confirmCls: 'bg-cerah-green text-white hover:bg-cerah-green-deep',
    success: 'Ditambahkan ke whitelist',
  }],
  ['whitelist-remove', {
    title: 'Hapus dari whitelist?',
    description: 'Pengirim kembali tunduk pada pemeriksaan eligibilitas dan batas per-pengguna.',
    confirm: 'Hapus',
    confirmCls: 'bg-ink text-white hover:bg-ink-hover',
    success: 'Dihapus dari whitelist',
  }],
  ['image-allow', {
    title: 'Beri izin kirim gambar?',
    description: 'Pengirim dapat melampirkan gambar saat mode gambar instance diatur ke allowlist.',
    confirm: 'Beri Izin',
    confirmCls: 'bg-cerah-green text-white hover:bg-cerah-green-deep',
    success: 'Izin gambar diberikan',
  }],
  ['image-deny', {
    title: 'Cabut izin kirim gambar?',
    description: 'Pengirim tidak dapat lagi melampirkan gambar pada mode allowlist.',
    confirm: 'Cabut Izin',
    confirmCls: 'bg-ink text-white hover:bg-ink-hover',
    success: 'Izin gambar dicabut',
  }],
])

/** The override field specs (limits family — 7 keys, pricing family — 3). */
const LIMIT_FIELDS = [
  { key: 'submissionCooldown', label: 'Cooldown kirim (menit)' },
  { key: 'submissionDailyCap', label: 'Batas kirim / hari' },
  { key: 'userPendingCap', label: 'Batas pending' },
  { key: 'userPostDailyCap', label: 'Batas posting / hari' },
  { key: 'minAccountAgeDays', label: 'Usia akun minimal (hari)' },
  { key: 'minFollowers', label: 'Followers minimal' },
  { key: 'minTotalPosts', label: 'Total tweet minimal' },
] as const

const PRICING_FIELDS = [
  { key: 'topupDiscountPercent', label: 'Diskon top-up (%)' },
  { key: 'pointsPerSubmission', label: 'Poin per submission' },
  { key: 'unblockFeeIdr', label: 'Biaya buka blokir (Rp)' },
] as const

function SkeletonRow() {
  return (
    <div className="rounded-2xl border border-line bg-surface px-3.5 py-3 [box-shadow:var(--shadow-sm)]">
      <div className="mb-2 flex items-center gap-2">
        <span className="cerah-skeleton size-8 rounded-full" />
        <span className="cerah-skeleton h-3 w-28 rounded-full" />
        <span className="cerah-skeleton h-3 w-16 rounded-full" />
      </div>
      <div className="cerah-skeleton h-3 w-2/3 rounded-full" />
    </div>
  )
}

export function SubmittersPanel({ instances, onUnauthorized }: SubmittersPanelProps) {
  const { toast } = useToast()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedInstances, setSelectedInstances] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const id = window.setTimeout(() => { setSearch(searchInput.trim()) }, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(id) }
  }, [searchInput])

  const enabledInstances = useMemo(() => instances.filter((i) => i.enabled), [instances])
  const instancesKey = useMemo(() => enabledInstances.map((i) => i.id).join(','), [enabledInstances])

  const buildQuery = useCallback((page: number) => {
    const params = new URLSearchParams({ page: String(page) })
    if (search.length > 0) params.set('search', search)
    if (selectedInstances.length > 0) params.set('instances', selectedInstances.join(','))
    return params.toString()
  }, [search, selectedInstances])

  const reloadKey = `${instancesKey}|${search}|${selectedInstances.slice().sort().join(',')}`

  const list = useInstanceSections<SubmitterItem, SubmittersSection>({
    endpoint: '/api/controller/submitters',
    buildQuery,
    reloadKey,
    getItems: (s) => s.items,
    withItems: (s, items) => ({ ...s, items }),
    itemKey: (item) => `${item.instanceId}:${item.username}`,
    sortItems: (a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0),
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
  const [pendingSimple, setPendingSimple] = useState<{ action: SubmitterAction; item: SubmitterItem } | null>(null)
  const [blockTarget, setBlockTarget] = useState<SubmitterItem | null>(null)
  const [blockReason, setBlockReason] = useState('')
  const [overridesTarget, setOverridesTarget] = useState<SubmitterItem | null>(null)
  const [pointsTarget, setPointsTarget] = useState<SubmitterItem | null>(null)

  const runAction = useCallback(async (
    action: SubmitterAction,
    item: SubmitterItem,
    extra?: Record<string, unknown>,
  ) => {
    if (busy) return
    setBusy(true)
    const result = await controllerFetch<QuickActionResponse>(
      `/api/controller/submitters/${encodeURIComponent(item.instanceId)}/${action}`,
      { method: 'POST', body: JSON.stringify({ username: item.username, ...extra }) },
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

  const afterAction = useCallback((action: SubmitterAction, body: unknown) => {
    const b = readActionBody(body)
    const description =
      action === 'points-adjust' && b.balance != null ? `Saldo sekarang ${b.balance} poin` : undefined
    toast({ title: 'Aksi berhasil dijalankan', ...(description != null ? { description } : {}) })
    void list.refresh()
  }, [list, toast])

  const confirmSimple = useCallback(async () => {
    if (pendingSimple == null) return
    const { action, item } = pendingSimple
    const envelope = await runAction(action, item)
    if (envelope != null) afterAction(action, envelope.body)
    setPendingSimple(null)
  }, [pendingSimple, runAction, afterAction])

  const confirmBlock = useCallback(async () => {
    if (blockTarget == null) return
    const extra: Record<string, unknown> = {}
    if (blockReason.trim().length > 0) extra.reason = blockReason.trim()
    const envelope = await runAction('block', blockTarget, extra)
    if (envelope != null) afterAction('block', envelope.body)
    setBlockTarget(null)
    setBlockReason('')
  }, [blockTarget, blockReason, runAction, afterAction])

  // ── Derived view data ────────────────────────────────
  const degradedSections = useMemo(
    () => list.sections.filter((s) => s.health !== 'ok'),
    [list.sections],
  )
  const unknownFlags = useMemo(
    () => list.sections.filter((s) => s.health === 'ok' && !s.flagsKnown),
    [list.sections],
  )
  const searching = search.length > 0
  const filtering = selectedInstances.length > 0

  const simpleCopy = pendingSimple != null ? SIMPLE_ACTIONS.get(pendingSimple.action) : undefined

  return (
    <section aria-labelledby="submitters-title" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="submitters-title" className="text-base font-bold tracking-[-0.01em] text-ink">Pengirim</h2>
          <span
            className="inline-flex min-w-6 items-center justify-center rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-xs font-bold text-ink-2 [font-variant-numeric:tabular-nums]"
            aria-label={`${list.total} pengirim`}
          >
            {list.total}
          </span>
        </div>
        <Button
          variant="ghost"
          onClick={() => { void list.refresh() }}
          disabled={list.isRefreshing}
          aria-label="Muat ulang daftar pengirim"
          className="size-11 shrink-0 rounded-full p-0 text-ink-3 hover:text-ink"
        >
          <RefreshCw className={cn('size-4', list.isRefreshing && 'animate-spin')} />
        </Button>
      </div>

      {/* Filters: instance chips + search */}
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
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Cari username / nama…"
          aria-label="Cari pengirim"
          className="ml-auto w-full sm:w-auto"
          inputClassName="sm:w-[200px]"
        />
      </div>

      {/* Fetch error */}
      {list.error != null && (
        <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Gagal memuat daftar pengirim: {list.error}
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
            <strong>{section.instanceName}</strong> — data pengirim tidak tersedia saat ini
            {section.error != null && section.error.length > 0 ? ` (${section.error})` : ''}
          </p>
        </div>
      ))}

      {/* Flags-unknown notice (filter-settings cross-reference failed) */}
      {unknownFlags.map((section) => (
        <p key={section.instanceId} className="m-0 rounded-lg border border-line bg-cerah-surface-2 px-3 py-2 text-xs text-ink-2">
          Status blokir/whitelist {section.instanceName} tidak dapat diverifikasi — daftar tetap ditampilkan.
        </p>
      ))}

      {/* The merged list */}
      {list.loading ? (
        <div className="flex flex-col gap-2.5" aria-label="Memuat daftar pengirim">
          {Array.from({ length: 4 }, (_, i) => <SkeletonRow key={i} />)}
        </div>
      ) : list.flatItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-10 text-center">
          <p className="m-0 text-sm font-semibold text-ink">
            {searching || filtering ? 'Tidak ada hasil' : 'Belum ada pengirim'}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            {searching
              ? `Tidak ada pengirim yang cocok dengan “${search}”.`
              : filtering
                ? 'Instance terpilih tidak punya pengirim.'
                : 'Pengirim dari semua instance akan muncul di sini.'}
          </p>
        </div>
      ) : (
        <ul role="list" className="flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {list.flatItems.map((item) => (
              <SubmitterRow
                key={`${item.instanceId}:${item.username}`}
                item={item}
                instanceSelected={selectedInstances.includes(item.instanceId)}
                degraded={list.sections.find((s) => s.instanceId === item.instanceId)?.health !== 'ok'}
                busy={busy}
                onInstanceClick={toggleInstance}
                onSimple={(action) => { setPendingSimple({ action, item }) }}
                onBlock={() => { setBlockTarget(item); setBlockReason('') }}
                onOverrides={() => { setOverridesTarget(item) }}
                onPoints={() => { setPointsTarget(item) }}
              />
            ))}
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

      {/* Simple-action confirms */}
      <AlertDialog open={pendingSimple != null} onOpenChange={(open) => { if (!open) setPendingSimple(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {simpleCopy?.title}
              {pendingSimple != null && (
                <span className="text-ink-2"> — @{pendingSimple.item.username} ({pendingSimple.item.instanceName})</span>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>{simpleCopy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Batal</AlertDialogCancel>
            <AlertDialogAction
              className={simpleCopy?.confirmCls}
              onClick={() => { void confirmSimple() }}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {simpleCopy?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Block dialog (reason input — a Dialog, not a bare confirm) */}
      <Dialog open={blockTarget != null} onOpenChange={(open) => { if (!open) { setBlockTarget(null); setBlockReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Blokir pengirim ini?
              {blockTarget != null && (
                <span className="text-ink-2"> — @{blockTarget.username} ({blockTarget.instanceName})</span>
              )}
            </DialogTitle>
            <DialogDescription>
              Pesan menunggu / disensor / gagal posting miliknya otomatis ditolak dan ia dikeluarkan
              dari whitelist. Pengirim blokir tetap tercatat di daftar.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="block-reason" className="text-xs font-semibold text-ink-2">
              Alasan (opsional)
            </label>
            <Input
              id="block-reason"
              value={blockReason}
              onChange={(e) => { setBlockReason(e.target.value) }}
              maxLength={200}
              placeholder="mis. spam berulang"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setBlockTarget(null); setBlockReason('') }} disabled={busy}>
              Batal
            </Button>
            <Button
              className="bg-cerah-red text-white hover:bg-cerah-red-strong"
              onClick={() => { void confirmBlock() }}
              disabled={busy}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Blokir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overrides dialog */}
      {overridesTarget != null && (
        <OverridesDialog
          item={overridesTarget}
          busy={busy}
          onClose={() => { setOverridesTarget(null) }}
          onSave={async (payload) => {
            const envelope = await runAction('overrides', overridesTarget, payload)
            if (envelope != null) afterAction('overrides', envelope.body)
            setOverridesTarget(null)
          }}
        />
      )}

      {/* Points-adjust dialog */}
      {pointsTarget != null && (
        <PointsDialog
          item={pointsTarget}
          busy={busy}
          onClose={() => { setPointsTarget(null) }}
          onSave={async (delta, note) => {
            const envelope = await runAction('points-adjust', pointsTarget, { delta, note })
            if (envelope != null) afterAction('points-adjust', envelope.body)
            setPointsTarget(null)
          }}
        />
      )}
    </section>
  )
}

// ── One submitter row ───────────────────────────────────────

interface SubmitterRowProps {
  item: SubmitterItem
  instanceSelected: boolean
  degraded: boolean
  busy: boolean
  onInstanceClick: (instanceId: string) => void
  onSimple: (action: SubmitterAction) => void
  onBlock: () => void
  onOverrides: () => void
  onPoints: () => void
}

function SubmitterRow({
  item,
  instanceSelected,
  degraded,
  busy,
  onInstanceClick,
  onSimple,
  onBlock,
  onOverrides,
  onPoints,
}: SubmitterRowProps) {
  const c = item.counts
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18 }}
      role="listitem"
      aria-label={`Pengirim @${item.username} di ${item.instanceName}`}
      className={cn(
        'rounded-2xl border border-line bg-surface [box-shadow:var(--shadow-sm)] transition-shadow hover:shadow-md',
        degraded && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          {/* Identity line */}
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-cerah-surface-2">
              {item.profileImage != null ? (
                <img src={item.profileImage} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" className="size-8 rounded-full object-cover" />
              ) : (
                <MaskGlyph className="size-4" />
              )}
            </span>
            <span className="text-sm font-bold text-ink">@{item.username}</span>
            {item.displayName != null && (
              <span className="truncate text-xs text-ink-3">{item.displayName}</span>
            )}
            <span className="text-xs text-ink-3">· daftar {formatRelativeTime(item.createdAt)}</span>

            {/* Instance badge — click filters to that instance */}
            <button
              type="button"
              onClick={() => { onInstanceClick(item.instanceId) }}
              aria-pressed={instanceSelected}
              aria-label={`Filter instance ${item.instanceName}`}
              className={cn(
                'relative ml-1 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold transition-colors',
                'after:absolute after:-inset-1.5 after:rounded-full after:content-[""]',
                instanceSelected
                  ? 'border-ink bg-ink text-white hover:bg-ink-hover'
                  : 'border-line bg-cerah-surface-2 text-ink-2 hover:bg-surface hover:text-ink',
              )}
            >
              <span
                className="size-1.5 rounded-full border border-line"
                style={item.instanceColor != null ? { backgroundColor: item.instanceColor } : { backgroundColor: 'var(--surface-3)' }}
                aria-hidden
              />
              {item.instanceName}
            </button>
          </div>

          {/* Flags */}
          <div className="mb-1 flex flex-wrap items-center gap-1">
            {item.blocked && (
              <Badge variant="outline" className="border-cerah-red-line bg-cerah-red-soft px-2 py-0.5 text-[10px] text-cerah-red">
                <Ban className="size-2.5" />
                Diblokir
              </Badge>
            )}
            {item.whitelisted && (
              <Badge variant="outline" className="border-cerah-green-line bg-cerah-green-soft px-2 py-0.5 text-[10px] text-cerah-green">
                <BadgeCheck className="size-2.5" />
                Whitelist
              </Badge>
            )}
            {item.imageAllowed && (
              <Badge variant="outline" className="border-xblue-line bg-xblue-soft px-2 py-0.5 text-[10px] text-xblue-ink">
                <ImageIcon className="size-2.5" />
                Izin gambar
              </Badge>
            )}
            {item.customLimits != null && (
              <Badge variant="outline" className="border-cerah-amber-line bg-cerah-amber-soft px-2 py-0.5 text-[10px] text-cerah-amber-strong">
                <SlidersHorizontal className="size-2.5" />
                Limit khusus
              </Badge>
            )}
            {item.customPricing != null && (
              <Badge variant="outline" className="border-cerah-amber-line bg-cerah-amber-soft px-2 py-0.5 text-[10px] text-cerah-amber-strong">
                <CircleDollarSign className="size-2.5" />
                Harga khusus
              </Badge>
            )}
          </div>

          {/* Submission counts */}
          <p className="m-0 text-xs text-ink-3 [font-variant-numeric:tabular-nums]">
            {c.total} total · {c.posted} terkirim · {c.pending} menunggu · {c.censored} disensor · {c.postFailed} gagal · {c.rejected} ditolak
          </p>
        </div>

        {/* Actions menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              disabled={degraded}
              aria-label={`Menu pengirim @${item.username}`}
              className="size-11 shrink-0 rounded-full p-0 text-ink-3 hover:text-ink md:size-9"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {item.blocked ? (
              <DropdownMenuItem disabled={busy} onSelect={() => { onSimple('unblock') }}>
                <UserCheck />
                Buka Blokir
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => { onBlock() }}>
                <UserX />
                Blokir…
              </DropdownMenuItem>
            )}
            {item.whitelisted ? (
              <DropdownMenuItem disabled={busy} onSelect={() => { onSimple('whitelist-remove') }}>
                <BadgeCheck />
                Hapus dari Whitelist
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={busy} onSelect={() => { onSimple('whitelist') }}>
                <BadgeCheck />
                Tambah ke Whitelist
              </DropdownMenuItem>
            )}
            {item.imageAllowed ? (
              <DropdownMenuItem disabled={busy} onSelect={() => { onSimple('image-deny') }}>
                <ImageIcon />
                Cabut Izin Gambar
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={busy} onSelect={() => { onSimple('image-allow') }}>
                <ImageIcon />
                Beri Izin Gambar
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onSelect={() => { onOverrides() }}>
              <SlidersHorizontal />
              Override Limit &amp; Harga…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => { onPoints() }}>
              <CircleDollarSign />
              Sesuaikan Poin…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </motion.li>
  )
}

// ── Overrides dialog (limits + pricing families) ───────────

interface OverridesDialogProps {
  item: SubmitterItem
  busy: boolean
  onClose: () => void
  onSave: (payload: { customLimits?: Record<string, number> | null; customPricing?: Record<string, number> | null }) => Promise<void>
}

/** One numeric override field — its own input state; empty = untouched. */
function OverrideField({
  id,
  label,
  current,
  onValue,
}: {
  id: string
  label: string
  current: number | null | undefined
  onValue: (id: string, raw: string) => void
}) {
  const [value, setValue] = useState('')
  const hint = current != null ? `saat ini ${current}` : 'belum di-override'
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`ov-${id}`} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <Input
        id={`ov-${id}`}
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          onValue(id, e.target.value)
        }}
        placeholder={hint}
        className="h-9"
      />
    </div>
  )
}

function OverridesDialog({ item, busy, onClose, onSave }: OverridesDialogProps) {
  const fieldValues = useRef(new Map<string, string>())
  const [clearLimits, setClearLimits] = useState(false)
  const [clearPricing, setClearPricing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleValue = useCallback((id: string, raw: string) => {
    const trimmed = raw.trim()
    if (trimmed.length === 0) fieldValues.current.delete(id)
    else fieldValues.current.set(id, trimmed)
  }, [])

  const save = async () => {
    const payload: { customLimits?: Record<string, number> | null; customPricing?: Record<string, number> | null } = {}
    const limits: Array<[string, number]> = []
    const pricing: Array<[string, number]> = []
    for (const field of LIMIT_FIELDS) {
      const raw = fieldValues.current.get(field.key)
      if (raw == null) continue
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < -1) {
        setError(`Nilai ${field.label} harus bilangan bulat ≥ -1`)
        return
      }
      limits.push([field.key, parsed])
    }
    for (const field of PRICING_FIELDS) {
      const raw = fieldValues.current.get(field.key)
      if (raw == null) continue
      const parsed = Number(raw)
      if (!Number.isInteger(parsed)) {
        setError(`Nilai ${field.label} harus bilangan bulat`)
        return
      }
      pricing.push([field.key, parsed])
    }
    if (clearLimits || limits.length > 0) {
      payload.customLimits = clearLimits ? null : Object.fromEntries(limits)
    }
    if (clearPricing || pricing.length > 0) {
      payload.customPricing = clearPricing ? null : Object.fromEntries(pricing)
    }
    if (payload.customLimits === undefined && payload.customPricing === undefined) {
      setError('Isi minimal satu field atau centang hapus')
      return
    }
    setError(null)
    await onSave(payload)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Override limit &amp; harga
            <span className="text-ink-2"> — @{item.username} ({item.instanceName})</span>
          </DialogTitle>
          <DialogDescription>
            Kosongkan field yang tidak diubah. Isi <code className="font-mono text-[0.7rem]">-1</code> untuk
            &quot;tanpa batas&quot; pada limit.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="m-0 flex flex-col gap-2.5 rounded-xl border border-line bg-cerah-surface-2/60 p-3">
          <legend className="px-1 text-xs font-bold text-ink">Limit per-pengguna</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {LIMIT_FIELDS.map((field) => (
              <OverrideField
                key={field.key}
                id={field.key}
                label={field.label}
                current={lookupNum(item.customLimits, field.key)}
                onValue={handleValue}
              />
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={clearLimits}
              onChange={(e) => { setClearLimits(e.target.checked) }}
              className="size-4 accent-[var(--ink)]"
            />
            Hapus semua override limit
          </label>
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-2.5 rounded-xl border border-line bg-cerah-surface-2/60 p-3">
          <legend className="px-1 text-xs font-bold text-ink">Harga khusus</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {PRICING_FIELDS.map((field) => (
              <OverrideField
                key={field.key}
                id={field.key}
                label={field.label}
                current={lookupNum(item.customPricing, field.key)}
                onValue={handleValue}
              />
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={clearPricing}
              onChange={(e) => { setClearPricing(e.target.checked) }}
              className="size-4 accent-[var(--ink)]"
            />
            Hapus semua override harga
          </label>
        </fieldset>

        {error != null && (
          <p role="alert" className="m-0 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs text-cerah-red">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Batal</Button>
          <Button onClick={() => { void save() }} disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Simpan Override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Points-adjust dialog ────────────────────────────────────

interface PointsDialogProps {
  item: SubmitterItem
  busy: boolean
  onClose: () => void
  onSave: (delta: number, note: string) => Promise<void>
}

function PointsDialog({ item, busy, onClose, onSave }: PointsDialogProps) {
  const [delta, setDelta] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const parsed = Number(delta.trim())
    if (!Number.isInteger(parsed) || parsed === 0) {
      setError('Delta harus bilangan bulat tidak nol (mis. -3 atau 5)')
      return
    }
    if (note.trim().length === 0) {
      setError('Catatan wajib diisi — menjadi jejak audit penyesuaian')
      return
    }
    setError(null)
    await onSave(parsed, note.trim())
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Sesuaikan poin
            <span className="text-ink-2"> — @{item.username} ({item.instanceName})</span>
          </DialogTitle>
          <DialogDescription>
            Refund atau kompensasi poin. Nilai negatif mengurangi saldo (mis.{' '}
            <code className="font-mono text-[0.7rem]">-3</code>), positif menambah.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="points-delta" className="text-xs font-semibold text-ink-2">Delta poin</label>
            <Input
              id="points-delta"
              type="number"
              inputMode="numeric"
              value={delta}
              onChange={(e) => { setDelta(e.target.value) }}
              placeholder="mis. -3"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="points-note" className="text-xs font-semibold text-ink-2">
              Catatan <span className="font-normal text-cerah-amber-strong">(wajib)</span>
            </label>
            <Textarea
              id="points-note"
              value={note}
              onChange={(e) => { setNote(e.target.value) }}
              maxLength={200}
              rows={3}
              placeholder="mis. refund post berbayar yang di-moderasi"
            />
          </div>
        </div>

        {error != null && (
          <p role="alert" className="m-0 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs text-cerah-red">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Batal</Button>
          <Button onClick={() => { void save() }} disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            <CheckCircle2 className="size-3.5" />
            Sesuaikan Poin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
