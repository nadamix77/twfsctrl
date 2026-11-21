'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  QueueAction,
  QueueActionPayload,
  QueueActionResponse,
  QueueItem,
  QueueResponse,
  QueueSection,
  QueueStatusFilter,
} from '@/lib/controller/types'
import { controllerFetch } from '@/hooks/use-controller-session'

// ============================================================
// use-controller-queue.ts — Unified moderation queue (Epic D)
//
// State machine over GET /api/controller/queue (per-instance
// sections). Page 1 is fetched on every param change (status tab,
// debounced search, instance multi-select); loadMore() appends the
// next page and MERGES items per section (dedupe by
// `${instanceId}:${id}`); refresh() re-reads pages 1..current.
//
// FR-D11: a degraded section (health != ok) KEEPS its previously
// loaded items — the slice freezes with its last-success timestamp
// instead of blanking, and the UI disables that instance's actions.
//
// FR-D10: on a 409 CAS conflict from runAction() the hook refetches
// THAT instance's section (pages 1..current) and raises a
// conflictNotice for it — the row re-renders with the instance's
// current state, never silently.
// ============================================================

export interface UseControllerQueueParams {
  /** Status tab. */
  status: QueueStatusFilter
  /** Debounced search string (the component owns the 400 ms debounce). */
  search: string
  /** Selected instance ids — empty array means "all instances". */
  instanceIds: string[]
  /** Fired when any call answers 401 (session expired mid-panel). */
  onUnauthorized?: () => void
}

export interface QueueTotals {
  /** Server-side total for the ACTIVE filter (sum of section.total). */
  all: number
  pending: number
  censored: number
  post_failed: number
  /** Per-status counts computed from the LOADED rows — on the "Semua"
  *  tab (which now spans every status) they are a first-page
  *  approximation; the exact server total exists only for the active
  *  filter (FR-D8 refund rows count under 'rejected'). */
  rejected: number
  /** In-flight rows — read-only, counted on "Semua" like the rest. */
  posting: number
  /** Posted rows (history with tweet links). */
  posted: number
}

export interface UseControllerQueue {
  sections: QueueSection[]
  flatItems: QueueItem[]
  totals: QueueTotals
  loading: boolean
  loadingMore: boolean
  isRefreshing: boolean
  error: string | null
  /** instanceId → verbatim conflict message (recent 409, auto-expires). */
  conflictNotice: Record<string, string>
  /** Body-carrying verbs (edit/censor) pass their payload here; the
   *   bodyless verbs omit it. */
  runAction: (instanceId: string, submissionId: string, action: QueueAction, body?: QueueActionPayload) => Promise<QueueActionResponse | null>
  removeItem: (instanceId: string, submissionId: string) => void
  updateItem: (instanceId: string, submissionId: string, patch: Partial<QueueItem>) => void
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  hasMore: boolean
}

const QUEUE_LIMIT = 50
const CONFLICT_NOTICE_MS = 8_000

function dedupeItems(items: QueueItem[]): QueueItem[] {
  const seen = new Set<string>()
  const out: QueueItem[] = []
  for (const item of items) {
    const key = `${item.instanceId}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** Fold one fetched section into the current slice.
 *
 *  append  — loadMore: union items, advance page/hasMore/total.
 *  refresh — same-params refetch: replace items when healthy.
 *  Both modes: a DEGRADED incoming section keeps the previous items
 *  (the frozen-slice rule, FR-D11) and only refreshes its flags. */
function foldSection(prev: QueueSection | undefined, incoming: QueueSection, mode: 'append' | 'refresh'): QueueSection {
  if (incoming.health !== 'ok') {
    if (prev === undefined) return incoming
    return {
      ...prev,
      health: incoming.health,
      error: incoming.error,
      retryAfterSec: incoming.retryAfterSec,
    }
  }
  if (mode === 'append' && prev !== undefined && prev.health === 'ok') {
    return { ...incoming, items: dedupeItems([...prev.items, ...incoming.items]) }
  }
  return incoming
}

export function useControllerQueue(params: UseControllerQueueParams): UseControllerQueue {
  const { status, search, instanceIds } = params

  const [sections, setSections] = useState<QueueSection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Map (not Record) — prototype-chain-safe keyed access (the SAST
  // object-injection idiom used across the instance app).
  const [conflictMap, setConflictMap] = useState(new Map<string, string>())

  const pageRef = useRef(1)
  const requestSeqRef = useRef(0)
  const loadMoreInFlightRef = useRef(false)
  const refreshInFlightRef = useRef(false)
  const conflictTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const onUnauthorizedRef = useRef(params.onUnauthorized)
  useEffect(() => { onUnauthorizedRef.current = params.onUnauthorized }, [params.onUnauthorized])

  // Latest params for the imperative paths (loadMore/refresh/409 refetch).
  const paramsRef = useRef({ status, search, instanceIds })
  useEffect(() => { paramsRef.current = { status, search, instanceIds } })

  // Stable identity of the instance selection — the param-change dep.
  const instanceKey = useMemo(() => instanceIds.slice().sort().join(','), [instanceIds])

  /** One page fetch. Returns null on fetch-level failure (error set). */
  const fetchSections = useCallback(async (page: number, ids: string[]): Promise<QueueSection[] | null> => {
    const current = paramsRef.current
    const query = new URLSearchParams({
      status: current.status,
      page: String(page),
      limit: String(QUEUE_LIMIT),
    })
    if (current.search.length > 0) query.set('search', current.search)
    if (ids.length > 0) query.set('instances', ids.join(','))
    const result = await controllerFetch<QueueResponse>(`/api/controller/queue?${query.toString()}`)
    if (result.status === 401) {
      onUnauthorizedRef.current?.()
      return null
    }
    if (!result.ok || result.data == null) {
      setError(result.error)
      return null
    }
    setError(null)
    return result.data.sections
  }, [])

  // Mirror of sections for the imperative merge paths.
  const sectionsRef = useRef<QueueSection[]>([])
  useEffect(() => { sectionsRef.current = sections })

  // ── Param change: fresh page-1 fetch (sections replaced wholesale). ──
  useEffect(() => {
    const seq = ++requestSeqRef.current
    let cancelled = false
    const ids = instanceKey.length > 0 ? instanceKey.split(',') : []
    const load = async () => {
      pageRef.current = 1
      setLoading(true)
      const fetched = await fetchSections(1, ids)
      if (cancelled || seq !== requestSeqRef.current) return
      if (fetched !== null) setSections(fetched)
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [status, search, instanceKey, fetchSections])

  /** Merge a fetched page set into the current sections. */
  const applyFetched = useCallback((fetched: QueueSection[], mode: 'append' | 'refresh') => {
    setSections((prev) =>
      fetched.map((incoming) => {
        const existing = prev.find((s) => s.instanceId === incoming.instanceId)
        return foldSection(existing, incoming, mode)
      }),
    )
  }, [])

  const loadMore = useCallback(async () => {
    if (loadMoreInFlightRef.current || loadingMore) return
    if (!sectionsRef.current.some((s) => s.hasMore && s.health === 'ok')) return
    loadMoreInFlightRef.current = true
    setLoadingMore(true)
    const seq = requestSeqRef.current
    const nextPage = pageRef.current + 1
    const fetched = await fetchSections(nextPage, paramsRef.current.instanceIds)
    if (fetched !== null && seq === requestSeqRef.current) {
      pageRef.current = nextPage
      applyFetched(fetched, 'append')
    }
    setLoadingMore(false)
    loadMoreInFlightRef.current = false
  }, [fetchSections, applyFetched, loadingMore])

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    setIsRefreshing(true)
    const seq = requestSeqRef.current
    const maxPage = Math.max(1, pageRef.current)
    // Re-read every loaded page (page 1 in the common case), folding page 1
    // against the CURRENT slices so a degraded instance keeps its frozen
    // items (FR-D11), then appending the deeper pages.
    let folded: QueueSection[] | null = null
    for (let page = 1; page <= maxPage; page++) {
      const fetched = await fetchSections(page, paramsRef.current.instanceIds)
      if (fetched === null || seq !== requestSeqRef.current) break
      if (folded === null) {
        folded = fetched.map((incoming) => {
          const existing = sectionsRef.current.find((s) => s.instanceId === incoming.instanceId)
          return foldSection(existing, incoming, 'refresh')
        })
      } else {
        folded = folded.map((section) => {
          const next = fetched.find((s) => s.instanceId === section.instanceId)
          return next === undefined
            ? section
            : foldSection(section, { ...next, items: dedupeItems([...section.items, ...next.items]) }, 'append')
        })
      }
    }
    if (folded !== null && seq === requestSeqRef.current) {
      setSections(folded.map((section) => ({ ...section, page: maxPage })))
    }
    setIsRefreshing(false)
    refreshInFlightRef.current = false
  }, [fetchSections])

  // ── 409 CAS conflict: refetch ONE instance's slice (pages 1..current). ──
  const refetchInstanceSection = useCallback(async (instanceId: string) => {
    const seq = requestSeqRef.current
    const maxPage = Math.max(1, pageRef.current)
    let merged: QueueSection | null = null
    for (let page = 1; page <= maxPage; page++) {
      const fetched = await fetchSections(page, [instanceId])
      if (fetched === null || seq !== requestSeqRef.current) return
      const section = fetched.find((s) => s.instanceId === instanceId)
      if (section === undefined) {
        // Instance left the fan-out (disabled/deleted) — drop its slice.
        setSections((prev) => prev.filter((s) => s.instanceId !== instanceId))
        return
      }
      if (section.health !== 'ok') {
        // Degraded — keep the previously loaded items, refresh the flags.
        setSections((prev) =>
          prev.map((s) =>
            s.instanceId === instanceId
              ? { ...s, health: section.health, error: section.error, retryAfterSec: section.retryAfterSec }
              : s,
          ),
        )
        return
      }
      const base: QueueSection = merged ?? section
      if (merged !== null) {
        merged = {
          ...base,
          items: dedupeItems([...base.items, ...section.items]),
          hasMore: section.hasMore,
          total: section.total,
        }
      } else {
        merged = base
      }
    }
    if (merged !== null) {
      const next = { ...merged, page: maxPage }
      setSections((prev) => prev.map((s) => (s.instanceId === instanceId ? next : s)))
    }
  }, [fetchSections])

  const setConflictNotice = useCallback((instanceId: string, message: string) => {
    setConflictMap((prev) => {
      const next = new Map(prev)
      next.set(instanceId, message)
      return next
    })
    const timers = conflictTimersRef.current
    const existing = timers.get(instanceId)
    if (existing !== undefined) clearTimeout(existing)
    timers.set(
      instanceId,
      setTimeout(() => {
        setConflictMap((prev) => {
          if (prev.get(instanceId) !== message) return prev
          const next = new Map(prev)
          next.delete(instanceId)
          return next
        })
        timers.delete(instanceId)
      }, CONFLICT_NOTICE_MS),
    )
  }, [])

  // Clear pending conflict timers on unmount.
  useEffect(() => {
    const timers = conflictTimersRef.current
    return () => { timers.forEach((t) => { clearTimeout(t) }); timers.clear() }
  }, [])

  const runAction = useCallback(
    async (
      instanceId: string,
      submissionId: string,
      action: QueueAction,
      body?: QueueActionPayload,
    ): Promise<QueueActionResponse | null> => {
      const path =
        `/api/controller/queue/${encodeURIComponent(instanceId)}` +
        `/${encodeURIComponent(submissionId)}/${action}`
      const result = await controllerFetch<QueueActionResponse>(path, {
        method: 'POST',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      if (result.status === 401) {
        onUnauthorizedRef.current?.()
        return null
      }
      if (!result.ok || result.data == null) {
        // HTTP-level failure (network, 404, 400 with error body) —
        // synthesize the envelope so the caller's toast path stays uniform.
        return { ok: false, status: result.status, body: null, error: result.error }
      }
      const envelope = result.data
      if (!envelope.ok && envelope.status === 409) {
        setConflictNotice(instanceId, envelope.error ?? 'Status submission telah berubah')
        void refetchInstanceSection(instanceId)
      }
      return envelope
    },
    [refetchInstanceSection, setConflictNotice],
  )

  const removeItem = useCallback((instanceId: string, submissionId: string) => {
    setSections((prev) =>
      prev.map((s) =>
        s.instanceId !== instanceId
          ? s
          : {
              ...s,
              items: s.items.filter((i) => i.id !== submissionId),
              total: Math.max(0, s.total - 1),
            },
      ),
    )
  }, [])

  const updateItem = useCallback((instanceId: string, submissionId: string, patch: Partial<QueueItem>) => {
    setSections((prev) =>
      prev.map((s) =>
        s.instanceId !== instanceId
          ? s
          : { ...s, items: s.items.map((i) => (i.id === submissionId ? { ...i, ...patch } : i)) },
      ),
    )
  }, [])

  const flatItems = useMemo(() => {
    const out = dedupeItems(sections.flatMap((s) => s.items))
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return out
  }, [sections])

  const conflictNotice = useMemo(
    () => Object.fromEntries(conflictMap.entries()),
    [conflictMap],
  )

  const totals = useMemo<QueueTotals>(() => {
    let all = 0
    let pending = 0
    let censored = 0
    let postFailed = 0
    let rejected = 0
    let posting = 0
    let posted = 0
    for (const section of sections) {
      all += section.total
      for (const item of section.items) {
        if (item.status === 'pending') pending += 1
        else if (item.status === 'censored') censored += 1
        else if (item.status === 'post_failed') postFailed += 1
        else if (item.status === 'rejected') rejected += 1
        else if (item.status === 'posting') posting += 1
        else if (item.status === 'posted') posted += 1
      }
    }
    return { all, pending, censored, post_failed: postFailed, rejected, posting, posted }
  }, [sections])

  const hasMore = useMemo(
    () => sections.some((s) => s.hasMore && s.health === 'ok'),
    [sections],
  )

  return {
    sections,
    flatItems,
    totals,
    loading,
    loadingMore,
    isRefreshing,
    error,
    conflictNotice,
    runAction,
    removeItem,
    updateItem,
    refresh,
    loadMore,
    hasMore,
  }
}
