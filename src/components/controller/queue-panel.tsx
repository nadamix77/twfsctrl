'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { InstanceDto, QueueItem, QueueSection, QueueStatusFilter } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { useControllerQueue, type QueueTotals } from '@/hooks/use-controller-queue'
import { QueueRow } from './queue-row'
import { cn } from '@/lib/core/utils'

// ============================================================
// queue-panel.tsx — the unified moderation queue (Epic D, §11.1)
//
// Status tabs + instance filter chips + debounced search feed the
// useControllerQueue state machine; the merged flat list (createdAt
// desc) renders as focusable rows with roving tabindex and A/R
// keyboard actions (§11.3). Degraded sections freeze above the list
// with their last-success timestamp (FR-D11).
// ============================================================

interface QueuePanelProps {
  instances: InstanceDto[]
  onUnauthorized: () => void
  /** Bumped by the dashboard after registry mutations / quick actions. */
  reloadSignal: number
}

const STATUS_TABS: ReadonlyArray<{ value: QueueStatusFilter; label: string; countKey: keyof QueueTotals }> = [
  // 'Semua' passes straight through to the instance contract's 'all'
  // list filter — every status shows here: pending, censored, posting,
  // post_failed, rejected (FR-D8 refund rows), posted (history).
  { value: 'all', label: 'Semua', countKey: 'all' },
  { value: 'pending', label: 'Menunggu', countKey: 'pending' },
  { value: 'censored', label: 'Disensor', countKey: 'censored' },
  { value: 'post_failed', label: 'Gagal Posting', countKey: 'post_failed' },
  { value: 'rejected', label: 'Ditolak', countKey: 'rejected' },
  { value: 'posting', label: 'Posting', countKey: 'posting' },
  { value: 'posted', label: 'Diposting', countKey: 'posted' },
]

/** Empty-state copy per tab (tabs without an entry fall back to the
 *  default "menunggu review" lines). Map, not Record — prototype-safe
 *  keyed lookup (the SAST object-injection idiom). */
const TAB_EMPTY_COPY = new Map<QueueStatusFilter, { title: string; hint: string }>([
  ['all', {
    title: 'Belum ada submission',
    hint: 'Semua kiriman dari semua instance — menunggu review, disensor, ditolak, hingga yang sudah diposting — muncul di sini.',
  }],
  ['rejected', {
    title: 'Tidak ada submission yang ditolak',
    hint: 'Pesan yang ditolak muncul di sini — tombol “Kembalikan Poin” tersedia untuk pesan berbayar.',
  }],
  ['posting', {
    title: 'Tidak ada submission yang sedang diposting',
    hint: 'Submission yang sedang dikirim ke X muncul di sini selama proses posting berlangsung.',
  }],
  ['posted', {
    title: 'Belum ada submission yang diposting',
    hint: 'Riwayat pesan yang berhasil diposting ke X muncul di sini, lengkap dengan tautan tweet-nya.',
  }],
])

const SEARCH_DEBOUNCE_MS = 400

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

function rowKeyOf(item: QueueItem): string {
  return `${item.instanceId}:${item.id}`
}

function SkeletonRow() {
  return (
    <div className="rounded-2xl border border-line bg-surface px-3.5 py-3 [box-shadow:var(--shadow-sm)]">
      <div className="mb-2 flex items-center gap-2">
        <span className="cerah-skeleton size-5 rounded-full" />
        <span className="cerah-skeleton h-3 w-24 rounded-full" />
        <span className="cerah-skeleton h-3 w-16 rounded-full" />
      </div>
      <div className="cerah-skeleton mb-1.5 h-3.5 w-full rounded-full" />
      <div className="cerah-skeleton mb-1.5 h-3.5 w-4/5 rounded-full" />
      <div className="cerah-skeleton h-3.5 w-2/3 rounded-full" />
    </div>
  )
}

export function QueuePanel({ instances, onUnauthorized, reloadSignal }: QueuePanelProps) {
  // ── Filter state (the queue hook's params) ────────────
  const [statusTab, setStatusTab] = useState<QueueStatusFilter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedInstances, setSelectedInstances] = useState<string[]>([])

  useEffect(() => {
    const id = window.setTimeout(() => { setSearch(searchInput.trim()) }, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(id) }
  }, [searchInput])

  const queue = useControllerQueue({ status: statusTab, search, instanceIds: selectedInstances, onUnauthorized })

  // ── Instance chips (enabled instances only — disabled ones are
  //    excluded from the fan-out, FR-B5) ─────────────────
  const enabledInstances = useMemo(() => instances.filter((i) => i.enabled), [instances])
  const instancesKey = useMemo(() => enabledInstances.map((i) => i.id).join(','), [enabledInstances])

  // Prune selections whose instance left the registry — the render-time
  // "adjust state when a prop changes" pattern (use-countdown idiom):
  // a selection pointing at a deleted instance would otherwise keep the
  // chips row pressed-empty forever.
  const [prunedKey, setPrunedKey] = useState<string | null>(null)
  if (prunedKey !== instancesKey) {
    setPrunedKey(instancesKey)
    if (selectedInstances.length > 0) {
      const ids = new Set(instancesKey.length > 0 ? instancesKey.split(',') : [])
      const next = selectedInstances.filter((id) => ids.has(id))
      if (next.length !== selectedInstances.length) setSelectedInstances(next)
    }
  }

  const toggleInstance = useCallback((instanceId: string) => {
    setSelectedInstances((prev) =>
      prev.includes(instanceId)
        ? prev.filter((id) => id !== instanceId)
        : [...prev, instanceId],
    )
  }, [])

  // Reload after dashboard-reported mutations (quick actions, instance
  // CRUD) — `reloadSignal` only. Registry-set changes ride the same
  // signal (afterRegistryChange bumps it), and the queue fetch resolves
  // its instance targets SERVER-side, so the client registry loading is
  // not a reload trigger. Ref indirection keeps the effect on the
  // latest refresh (admin-stats-context idiom).
  const queueRefresh = queue.refresh
  const queueRefreshRef = useRef(queueRefresh)
  useEffect(() => { queueRefreshRef.current = queueRefresh }, [queueRefresh])
  useEffect(() => {
    if (reloadSignal === 0) return
    void queueRefreshRef.current()
  }, [reloadSignal])

  // ── Roving tabindex + A/R keyboard actions (§11.3) ────
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const rowActions = useRef(new Map<string, { primary: () => void; reject: () => void }>())
  const [focusedKey, setFocusedKey] = useState<string | null>(null)

  const registerRef = useCallback((key: string, el: HTMLLIElement | null) => {
    if (el == null) rowRefs.current.delete(key)
    else rowRefs.current.set(key, el)
  }, [])

  const registerActions = useCallback((
    key: string,
    actions: { primary: () => void; reject: () => void } | null,
  ) => {
    if (actions == null) rowActions.current.delete(key)
    else rowActions.current.set(key, actions)
  }, [])

  // A removed focused row resets the roving anchor to the first row —
  // render-time adjustment while a prop changes (the use-countdown
  // idiom), not an effect.
  const keySet = useMemo(() => new Set(queue.flatItems.map(rowKeyOf)), [queue.flatItems])
  if (focusedKey != null && !keySet.has(focusedKey)) {
    setFocusedKey(null)
  }

  const focusRowKey = useCallback((key: string) => {
    rowRefs.current.get(key)?.focus()
  }, [])

  const handleRowKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLLIElement>,
    item: QueueItem,
  ) => {
    // No keyboard actions while an input has focus (search, dialogs are
    // portaled so they never bubble here).
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

    const key = rowKeyOf(item)
    const keys = queue.flatItems.map(rowKeyOf)
    const index = keys.indexOf(key)
    if (index < 0) return

    switch (event.key) {
      case 'ArrowDown': {
        const next = keys[index + 1]
        if (next !== undefined) {
          event.preventDefault()
          focusRowKey(next)
        }
        break
      }
      case 'ArrowUp': {
        const prev = keys[index - 1]
        if (prev !== undefined) {
          event.preventDefault()
          focusRowKey(prev)
        }
        break
      }
      case 'a':
      case 'A': {
        event.preventDefault()
        rowActions.current.get(key)?.primary()
        break
      }
      case 'r':
      case 'R': {
        event.preventDefault()
        rowActions.current.get(key)?.reject()
        break
      }
    }
  }, [queue.flatItems, focusRowKey])

  // ── Derived view data ─────────────────────────────────
  const sectionByInstance = useMemo(() => {
    const map = new Map<string, QueueSection>()
    for (const section of queue.sections) map.set(section.instanceId, section)
    return map
  }, [queue.sections])

  const degradedSections = useMemo(
    () => queue.sections.filter((s) => s.health !== 'ok'),
    [queue.sections],
  )

  // Tab counts: the ACTIVE tab carries the server-side total for its
  // filter (sum of section.total); on the "all" tab every per-status
  // count comes from the loaded rows (first-page approximation — the
  // server total exists only for the active filter). Rows on the
  // posting/posted tabs are read-only (the instance refuses mutations
  // from those statuses) — visibility only.
  const tabCount = useCallback((tab: QueueStatusFilter): number | null => {
    if (tab === statusTab) return queue.totals.all
    if (statusTab === 'all') {
      return queue.totals[STATUS_TABS.find((t) => t.value === tab)?.countKey ?? 'all']
    }
    return null
  }, [statusTab, queue.totals])

  const searching = search.length > 0
  const filtering = selectedInstances.length > 0
  const emptyCopy = TAB_EMPTY_COPY.get(statusTab)

  return (
    <section aria-labelledby="queue-title" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="queue-title" className="text-base font-bold tracking-[-0.01em] text-ink">Antrean Moderasi</h2>
          <span
            className="inline-flex min-w-6 items-center justify-center rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-xs font-bold text-ink-2 [font-variant-numeric:tabular-nums]"
            aria-label={`${queue.totals.all} submission`}
          >
            {queue.totals.all}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Keyboard hint (§11.3) */}
          <span className="hidden items-center gap-1.5 text-xs text-ink-3 md:flex" aria-hidden>
            <kbd className="rounded border border-line bg-cerah-surface-2 px-1 font-mono text-[0.65rem]">A</kbd> setujui
            <span aria-hidden>·</span>
            <kbd className="rounded border border-line bg-cerah-surface-2 px-1 font-mono text-[0.65rem]">R</kbd> tolak
            <span aria-hidden>·</span>
            <kbd className="rounded border border-line bg-cerah-surface-2 px-1 font-mono text-[0.65rem]">↑↓</kbd> navigasi
          </span>
          <Button
            variant="ghost"
            onClick={() => { void queue.refresh() }}
            disabled={queue.isRefreshing}
            aria-label="Muat ulang antrean"
            className="size-11 shrink-0 rounded-full p-0 text-ink-3 hover:text-ink"
          >
            <RefreshCw className={cn('size-4', queue.isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Filters: status tabs (scrollable row), then chips + search */}
      <div className="flex flex-col gap-1.5">
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
          <div
            role="group"
            aria-label="Filter status"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-line bg-cerah-surface-2 p-0.5"
          >
            {STATUS_TABS.map((tab) => {
              const count = tabCount(tab.value)
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
                  {count != null && count > 0 && (
                    <span className="text-xs text-ink-3 [font-variant-numeric:tabular-nums]">{count}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Instance chips */}
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
            placeholder="Cari pesan / username…"
            aria-label="Cari pesan atau username"
            className="ml-auto w-full sm:w-auto"
            inputClassName="sm:w-[200px]"
          />
        </div>
      </div>

      {/* Fetch error — stale data stays below, never silently blank */}
      {queue.error != null && (
        <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Gagal memuat antrean: {queue.error}
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
            <strong>{section.instanceName}</strong> — frozen, terakhir berhasil: {timeOfDay(section.lastFetchedAt)}
            {section.error != null && section.error.length > 0 ? ` (${section.error})` : ''}
          </p>
        </div>
      ))}

      {/* 409 conflict notices (FR-D10 — never silent) */}
      {Object.entries(queue.conflictNotice).map(([instanceId, message]) => {
        const name = sectionByInstance.get(instanceId)?.instanceName ?? 'Instance'
        return (
          <p key={instanceId} className="m-0 rounded-lg border border-xblue-line bg-xblue-soft px-3 py-2 text-xs text-xblue-ink" title={message}>
            {name}: status submission berubah — data dimuat ulang.
          </p>
        )
      })}

      {/* The merged list */}
      {queue.loading ? (
        <div className="flex flex-col gap-2.5" aria-label="Memuat antrean">
          {Array.from({ length: 4 }, (_, i) => <SkeletonRow key={i} />)}
        </div>
      ) : queue.flatItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-10 text-center">
          <p className="m-0 text-sm font-semibold text-ink">
            {searching || filtering
              ? 'Tidak ada hasil'
              : emptyCopy?.title ?? 'Tidak ada submission menunggu review'}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            {searching
              ? `Tidak ada pesan yang cocok dengan “${search}”.`
              : filtering
                ? 'Instance terpilih tidak punya submission pada filter ini.'
                : emptyCopy?.hint ?? 'Submission baru dari semua instance akan muncul di sini.'}
          </p>
        </div>
      ) : (
        <ul role="list" className="flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {queue.flatItems.map((item, index) => {
              const key = rowKeyOf(item)
              const firstKey = rowKeyOf(queue.flatItems[0] ?? item)
              return (
                <QueueRow
                  key={key}
                  item={item}
                  rowKey={key}
                  index={index}
                  tabIndex={focusedKey === key || (focusedKey == null && key === firstKey) ? 0 : -1}
                  degraded={sectionByInstance.get(item.instanceId)?.health !== 'ok'}
                  instanceSelected={selectedInstances.includes(item.instanceId)}
                  onAction={(action, body) => queue.runAction(item.instanceId, item.id, action, body)}
                  onRemove={() => { queue.removeItem(item.instanceId, item.id) }}
                  onUpdate={(patch) => { queue.updateItem(item.instanceId, item.id, patch) }}
                  onInstanceClick={toggleInstance}
                  onFocusRow={setFocusedKey}
                  onKeyDown={handleRowKeyDown}
                  registerRef={registerRef}
                  registerActions={registerActions}
                />
              )
            })}
          </AnimatePresence>
        </ul>
      )}

      {/* Pagination */}
      {queue.hasMore && !queue.loading && (
        <Button
          variant="outline"
          onClick={() => { void queue.loadMore() }}
          disabled={queue.loadingMore}
          className="self-center"
        >
          {queue.loadingMore && <Loader2 className="size-4 animate-spin" />}
          {queue.loadingMore ? 'Memuat…' : 'Muat lagi'}
        </Button>
      )}
      {queue.loadingMore && !queue.hasMore && (
        <p className="m-0 flex items-center justify-center gap-2 self-center text-xs text-ink-3">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Memuat…
        </p>
      )}
    </section>
  )
}
