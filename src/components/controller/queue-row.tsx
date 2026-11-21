'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CheckCircle2,
  Coins,
  ExternalLink,
  ImageIcon,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import type { QueueAction, QueueActionResponse, QueueItem } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { FilterReasons } from '@/components/shared/filter-reasons'
import { MaskGlyph } from '@/components/shared/mask-glyph'
import { PaidPostMark } from '@/components/shared/paid-post-mark'
import { StatusBadge } from '@/components/shared/status-badge'
import { XLogo } from '@/components/shared/x-logo'
import { useToast } from '@/hooks/use-toast'
import { formatRelativeTime } from '@/lib/core/format'
import { cn } from '@/lib/core/utils'
import type { SubmissionStatus } from '@/types'

// ============================================================
// queue-row.tsx — one merged submission row (FR-D1, §11.3)
//
// Instance badge, submitter, status chips, message (line-clamp-3 +
// expand), image thumb (controller proxy URL), raw filter reasons,
// post error, and the per-status action set. Approve/retry handle
// the instance's three success shapes distinctly (FR-D4); every
// outcome toasts with the instance's copy verbatim (FR-E2 doctrine).
// Rows are focusable list items with roving tabindex (↑↓ navigate,
// A = primary action, R = reject).
// ============================================================

interface QueueRowProps {
  item: QueueItem
  /** Section health != ok — every action disabled, row dimmed (FR-D11). */
  degraded: boolean
  /** Row key: `${instanceId}:${id}`. */
  rowKey: string
  index: number
  tabIndex: number
  instanceSelected: boolean
  onAction: (action: QueueAction) => Promise<QueueActionResponse | null>
  onRemove: () => void
  onUpdate: (patch: Partial<QueueItem>) => void
  onInstanceClick: (instanceId: string) => void
  onFocusRow: (rowKey: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLLIElement>, item: QueueItem) => void
  registerRef: (rowKey: string, el: HTMLLIElement | null) => void
  registerActions: (rowKey: string, actions: { primary: () => void; reject: () => void } | null) => void
}

/** Defensive readers for the VERBATIM instance body (NFR-X1). */
function readBody(body: unknown): {
  kind?: string | undefined
  tweetId?: string | undefined
  message?: string | undefined
  deferReason?: string | undefined
  warning?: string | undefined
  error?: string | undefined
  refund?: string | undefined
  submission?: unknown
} {
  if (body == null || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  return {
    kind: typeof b.kind === 'string' ? b.kind : undefined,
    tweetId: typeof b.tweetId === 'string' ? b.tweetId : undefined,
    message: typeof b.message === 'string' ? b.message : undefined,
    deferReason: typeof b.deferReason === 'string' ? b.deferReason : undefined,
    warning: typeof b.warning === 'string' ? b.warning : undefined,
    error: typeof b.error === 'string' ? b.error : undefined,
    refund: typeof b.refund === 'string' ? b.refund : undefined,
    submission: b.submission ?? null,
  }
}

function readSubmissionStatus(body: ReturnType<typeof readBody>): string | null {
  const submission = body.submission
  if (submission == null || typeof submission !== 'object' || !('status' in submission)) return null
  const status = submission.status
  return typeof status === 'string' ? status : null
}

const KNOWN_STATUSES = new Set<string>(['pending', 'censored', 'posting', 'post_failed', 'rejected', 'posted'])

function isKnownStatus(status: string): status is SubmissionStatus {
  return KNOWN_STATUSES.has(status)
}

/** Past this length the "selengkapnya" expander appears (≈3 clamped lines). */
const EXPAND_THRESHOLD = 160

/** Submitter avatar — plain <img> (instance-signed URL) with the mask
 *  glyph as the broken/absent fallback (never next/image: these URLs
 *  are foreign and short-lived). */
function RowAvatar({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false)
  if (src != null && src.length > 0 && !broken) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        onError={() => { setBroken(true) }}
        className="size-5 shrink-0 rounded-full border border-line-soft object-cover"
      />
    )
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-cerah-surface-2">
      <MaskGlyph className="size-3" />
    </span>
  )
}

export function QueueRow({
  item,
  degraded,
  rowKey,
  index,
  tabIndex,
  instanceSelected,
  onAction,
  onRemove,
  onUpdate,
  onInstanceClick,
  onFocusRow,
  onKeyDown,
  registerRef,
  registerActions,
}: QueueRowProps) {
  const { toast } = useToast()
  const [busyAction, setBusyAction] = useState<QueueAction | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [imgBroken, setImgBroken] = useState(false)

  const isPending = item.status === 'pending'
  const isCensored = item.status === 'censored'
  const isFailed = item.status === 'post_failed'
  const isRejected = item.status === 'rejected'
  const busy = busyAction != null

  // ── Envelope handling ────────────────────────────────

  const handleEnvelopeError = useCallback((envelope: QueueActionResponse) => {
    if (envelope.status === 409) {
      // CAS conflict — the hook refetches the section; tell the operator.
      toast({
        title: envelope.error ?? 'Konflik status',
        description: 'Status submission telah berubah — data dimuat ulang.',
        variant: 'destructive',
      })
      return
    }
    if (envelope.status === 503) {
      toast({
        title: envelope.error ?? 'Instance tidak tersedia',
        description: 'Circuit breaker aktif di instance — coba quick action Reset Circuit Breaker.',
        variant: 'destructive',
      })
      return
    }
    toast({ title: envelope.error ?? 'Gagal terhubung ke server', variant: 'destructive' })
  }, [toast])

  const handleApproveLike = useCallback((body: unknown) => {
    const b = readBody(body)
    if (b.kind === 'auto-posted') {
      onRemove()
      toast({
        title: 'Diposting ke X',
        description: b.tweetId != null
          ? (
              <span>
                {b.warning != null ? `${b.warning} · ` : ''}
                <a href={`https://x.com/i/status/${b.tweetId}`} target="_blank" rel="noopener noreferrer" className="underline">
                  Lihat tweet
                </a>
              </span>
            )
          : b.warning,
      })
      return
    }
    if (b.kind === 'queued') {
      // Deferred by the instance — the row stays reviewable as pending.
      const nextStatus = readSubmissionStatus(b)
      onUpdate({ status: nextStatus != null && isKnownStatus(nextStatus) ? nextStatus : 'pending' })
      toast({ title: b.message ?? 'Posting ditunda oleh instance', description: b.deferReason })
      return
    }
    if (b.kind === 'error') {
      // Approved but the post failed — keep the row as post_failed.
      const nextStatus = readSubmissionStatus(b)
      onUpdate({
        ...(nextStatus != null && isKnownStatus(nextStatus) ? { status: nextStatus } : {}),
        ...(b.error != null ? { postError: b.error } : {}),
      })
      toast({ title: b.error ?? 'Posting gagal', variant: 'destructive' })
      return
    }
    // Unknown shape (instance drift, NFR-X1) — keep the row, surface the copy.
    if (b.error != null) toast({ title: b.error, variant: 'destructive' })
    else toast({ title: b.message ?? 'Aksi selesai' })
  }, [onRemove, onUpdate, toast])

  const handleAction = useCallback(async (action: QueueAction) => {
    if (busy || degraded) return
    setBusyAction(action)
    const envelope = await onAction(action)
    setBusyAction(null)
    if (envelope == null) return // transport/401 — the hook already cascaded
    if (!envelope.ok) {
      handleEnvelopeError(envelope)
      return
    }
    switch (action) {
      case 'approve':
      case 'retry': {
        handleApproveLike(envelope.body)
        break
      }
      case 'reject': {
        const refund = readBody(envelope.body).refund
        onRemove()
        toast({
          title: 'Pesan ditolak',
          description:
            refund === 'refunded'
              ? 'Poin dikembalikan'
              : refund === 'over-balance'
                ? 'Refund melebihi batas saldo — gunakan tombol Kembalikan Poin nanti'
                : refund != null
                  ? `Refund: ${refund}`
                  : undefined,
        })
        break
      }
      case 'refund': {
        const refund = readBody(envelope.body).refund
        if (refund === 'over-balance') {
          // Refund blocked — the row stays so the operator can retry later.
          toast({
            title: 'Refund melebihi batas saldo',
            description: 'Coba lagi nanti setelah saldo pembuat turun.',
            variant: 'destructive',
          })
          return
        }
        onRemove()
        toast({ title: refund === 'refunded' ? 'Poin dikembalikan' : `Refund: ${refund ?? 'selesai'}` })
        break
      }
      case 'delete': {
        const refund = readBody(envelope.body).refund
        onRemove()
        toast({ title: 'Pesan dihapus', description: refund === 'refunded' ? 'Poin dikembalikan' : undefined })
        break
      }
    }
  }, [busy, degraded, onAction, onRemove, handleEnvelopeError, handleApproveLike, toast])

  const triggerPrimary = useCallback(() => {
    if (isPending || isCensored) void handleAction('approve')
    else if (isFailed) void handleAction('retry')
  }, [isPending, isCensored, isFailed, handleAction])
  const triggerReject = useCallback(() => {
    if (isPending || isCensored || isFailed) void handleAction('reject')
  }, [isPending, isCensored, isFailed, handleAction])

  // Keep the keyboard handlers fresh for the panel's global A/R keys.
  useEffect(() => {
    registerActions(rowKey, { primary: triggerPrimary, reject: triggerReject })
    return () => { registerActions(rowKey, null) }
  })

  const longMessage = item.message.length > EXPAND_THRESHOLD || item.message.split('\n').length > 3

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18, delay: Math.min(index, 10) * 0.03 }}
      role="listitem"
      tabIndex={tabIndex}
      aria-label={`Pesanan dari @${item.submitter.username} di ${item.instanceName}`}
      onFocus={() => { onFocusRow(rowKey) }}
      onKeyDown={(e) => { onKeyDown(e, item) }}
      ref={(el) => { registerRef(rowKey, el) }}
      className={cn(
        'rounded-2xl border border-line bg-surface [box-shadow:var(--shadow-sm)] transition-shadow hover:shadow-md',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        degraded && 'opacity-60',
      )}
    >
      <div className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
        {/* Content column */}
        <div className="min-w-0 flex-1">
          {/* Identity line */}
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <RowAvatar src={item.submitter.profileImage} />
            <span className="text-xs font-semibold text-ink">@{item.submitter.username}</span>
            {item.submitter.displayName != null && item.submitter.displayName.length > 0 && (
              <span className="truncate text-xs text-ink-3">{item.submitter.displayName}</span>
            )}
            <span className="text-xs text-ink-3">· {formatRelativeTime(item.createdAt)}</span>

            {/* Instance badge — click filters to that instance. The
                pseudo-element expands the tap target beyond the tiny
                visual pill (mobile touch, ≥30px effective). */}
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

            {isKnownStatus(item.status)
              ? <StatusBadge status={item.status} />
              : <Badge variant="outline" className="border-line bg-cerah-surface-2 px-2 py-0.5 text-[10px] text-ink-2">{item.status}</Badge>}
            {item.nsfwStatus != null && item.nsfwStatus !== 'approved' && (
              <Badge
                variant="outline"
                className={cn(
                  'px-1.5 py-0 text-[10px]',
                  item.nsfwStatus === 'flagged'
                    ? 'border-cerah-amber-line bg-cerah-amber-soft text-cerah-amber-strong'
                    : item.nsfwStatus === 'rejected'
                      ? 'border-cerah-red-line bg-cerah-red-soft text-cerah-red'
                      : 'border-line bg-cerah-surface-2 text-ink-2',
                )}
              >
                <ImageIcon className="size-2.5" />
                {item.nsfwStatus === 'flagged' ? 'NSFW ditandai' : item.nsfwStatus === 'rejected' ? 'NSFW ditolak' : 'NSFW menunggu'}
              </Badge>
            )}
            {item.paidPost && <PaidPostMark />}
            {item.tweetId != null && (
              <a
                href={`https://x.com/i/status/${item.tweetId}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Lihat tweet di X"
                className="inline-flex items-center text-ink-2 hover:text-ink"
              >
                <XLogo className="size-3" />
                <ExternalLink className="size-2.5" />
              </a>
            )}
          </div>

          {/* Message + thumb */}
          <div className="flex gap-2.5">
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm leading-relaxed whitespace-pre-wrap break-words text-ink', !expanded && 'line-clamp-3')}>
                {item.message}
              </p>
              {longMessage && (
                <button
                  type="button"
                  onClick={() => { setExpanded((v) => !v) }}
                  className="mt-0.5 cursor-pointer text-xs font-semibold text-ink-2 hover:text-ink"
                  aria-expanded={expanded}
                >
                  {expanded ? 'ringkas' : 'selengkapnya'}
                </button>
              )}
              {item.postError != null && (
                <p className="m-0 mt-1.5 line-clamp-2 text-xs leading-relaxed break-words text-cerah-red">
                  {item.postError}
                </p>
              )}
              <FilterReasons
                filterReasons={item.filterReasons.length > 0 ? JSON.stringify(item.filterReasons) : null}
              />
            </div>

            {/* Image thumb — the controller proxy re-fetches a fresh signed
                URL server-side, so a plain new-tab link is enough (E11). */}
            {item.hasImage && item.imageUrl != null && (
              <a
                href={item.imageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 self-start"
                aria-label="Lihat gambar asli"
              >
                {imgBroken ? (
                  <span className="flex size-16 items-center justify-center rounded-lg border border-line bg-cerah-surface-2 p-1.5 text-center text-[0.6rem] leading-tight text-ink-3">
                    Gambar tidak tersedia
                  </span>
                ) : (
                  <img
                    src={item.imageUrl}
                    alt="Gambar kiriman"
                    loading="lazy"
                    decoding="async"
                    onError={() => { setImgBroken(true) }}
                    className="size-16 rounded-lg border border-line object-cover"
                  />
                )}
              </a>
            )}
          </div>
        </div>

        {/* Action column — stacks below content on mobile */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:pt-0.5">
          {(isPending || isCensored) && (
            <Button
              size="sm"
              onClick={() => { void handleAction('approve') }}
              disabled={busy || degraded}
              className="h-11 min-h-11 bg-cerah-green px-4 text-xs hover:bg-cerah-green-deep text-white md:h-9 md:min-h-9 md:text-[0.875rem]"
            >
              {busyAction === 'approve'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <CheckCircle2 className="size-3.5" />}
              Setujui
            </Button>
          )}
          {(isPending || isCensored || isFailed) && (
            <Button
              size="sm"
              variant="destructive-outline"
              onClick={() => { void handleAction('reject') }}
              disabled={busy || degraded}
              className="h-11 min-h-11 px-4 text-xs md:h-9 md:min-h-9 md:text-[0.875rem]"
            >
              {busyAction === 'reject' && <Loader2 className="size-3.5 animate-spin" />}
              Tolak
            </Button>
          )}
          {isFailed && (
            <Button
              size="sm"
              onClick={() => { void handleAction('retry') }}
              disabled={busy || degraded}
              className="h-11 min-h-11 bg-ink px-4 text-xs hover:bg-ink-hover text-white md:h-9 md:min-h-9 md:text-[0.875rem]"
            >
              {busyAction === 'retry'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <RotateCcw className="size-3.5" />}
              Coba Lagi
            </Button>
          )}
          {/* P1: retry also available on pending rows (FR-D6) */}
          {isPending && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { void handleAction('retry') }}
              disabled={busy || degraded}
              aria-label="Coba posting sekarang"
              className="size-11 p-0 text-ink-3 hover:text-ink md:size-9"
            >
              {busyAction === 'retry'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <RotateCcw className="size-3.5" />}
            </Button>
          )}
          {isRejected && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { void handleAction('refund') }}
              disabled={busy || degraded}
              className="h-11 min-h-11 bg-cerah-green px-4 text-xs text-cerah-green hover:bg-cerah-green hover:text-white md:h-9 md:min-h-9 md:text-[0.875rem]"
            >
              {busyAction === 'refund'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Coins className="size-3.5" />}
              Kembalikan Poin
            </Button>
          )}

          {/* Delete — behind a confirm (FR-D7) */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || degraded}
                aria-label="Hapus pesan"
                className="size-11 p-0 text-ink-3 hover:text-cerah-red md:size-9"
              >
                {busyAction === 'delete'
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Trash2 className="size-3.5" />}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Hapus pesan ini?</AlertDialogTitle>
                <AlertDialogDescription>
                  Pesan dihapus permanen di instance {item.instanceName} dan tidak dapat dikembalikan.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Batal</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-cerah-red text-white hover:bg-cerah-red-strong"
                  onClick={() => { void handleAction('delete') }}
                >
                  {busyAction === 'delete' && <Loader2 className="size-3.5 animate-spin" />}
                  Hapus
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </motion.li>
  )
}
