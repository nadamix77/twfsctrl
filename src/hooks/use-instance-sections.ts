'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstanceHealth } from '@/lib/controller/types'
import { controllerFetch } from '@/hooks/use-controller-session'

// ============================================================
// use-instance-sections.ts — generic per-instance sections state
// machine (the use-controller-queue doctrine, generalized)
//
// Powers the Submitters and Payments panels: page 1 fetched on every
// param change (the `reloadKey` identity), loadMore() appends + merges
// per section (dedupe by item key), refresh() re-reads pages 1..current.
// FR-D11: a degraded section KEEPS its previously loaded items — the
// slice freezes with its last-success timestamp instead of blanking.
//
// The section shape is structural: any TSection carrying the core
// fields works; `getItems`/`withItems` adapt the panel-specific
// items field (items vs orders).
// ============================================================

/** The structural core every fan-out section carries. */
export interface SectionCore {
  instanceId: string
  instanceName: string
  instanceColor: string | null
  health: InstanceHealth
  error: string | null
  retryAfterSec: number | null
  page: number
  hasMore: boolean
  total: number
  lastFetchedAt: string
}

export interface UseInstanceSectionsParams<TItem, TSection extends SectionCore> {
  /** API path, e.g. '/api/controller/submitters'. */
  endpoint: string
  /** Full query string for one page (params + instance filter). */
  buildQuery: (page: number) => string
  /** Identity of the current params — a change refetches page 1. */
  reloadKey: string
  getItems: (section: TSection) => TItem[]
  withItems: (section: TSection, items: TItem[]) => TSection
  itemKey: (item: TItem) => string
  sortItems?: (a: TItem, b: TItem) => number
  /** Fired when any call answers 401 (session expired mid-panel). */
  onUnauthorized?: () => void
}

export interface UseInstanceSections<TItem, TSection extends SectionCore> {
  sections: TSection[]
  flatItems: TItem[]
  /** Sum of section.total — the server-side total for the active filter. */
  total: number
  loading: boolean
  loadingMore: boolean
  isRefreshing: boolean
  error: string | null
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  hasMore: boolean
}

function dedupe<TItem>(items: TItem[], keyOf: (item: TItem) => string): TItem[] {
  const seen = new Set<string>()
  const out: TItem[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** Fold one fetched section into the current slice (FR-D11 frozen
 *  sections keep their items; append merges + dedupes). */
function foldSection<TItem, TSection extends SectionCore>(
  params: UseInstanceSectionsParams<TItem, TSection>,
  prev: TSection | undefined,
  incoming: TSection,
  mode: 'append' | 'refresh',
): TSection {
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
    return params.withItems(
      incoming,
      dedupe([...params.getItems(prev), ...params.getItems(incoming)], params.itemKey),
    )
  }
  return incoming
}

export function useInstanceSections<TItem, TSection extends SectionCore>(
  params: UseInstanceSectionsParams<TItem, TSection>,
): UseInstanceSections<TItem, TSection> {
  const { endpoint, reloadKey } = params

  const [sections, setSections] = useState<TSection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pageRef = useRef(1)
  const requestSeqRef = useRef(0)
  const loadMoreInFlightRef = useRef(false)
  const refreshInFlightRef = useRef(false)

  // Latest params for the imperative paths (loadMore/refresh) — refs so
  // the flatItems memo stays keyed on `sections` only.
  const paramsRef = useRef(params)
  useEffect(() => { paramsRef.current = params })

  const onUnauthorizedRef = useRef(params.onUnauthorized)
  useEffect(() => { onUnauthorizedRef.current = params.onUnauthorized }, [params.onUnauthorized])

  // Mirror of sections for the imperative merge paths.
  const sectionsRef = useRef<TSection[]>([])
  useEffect(() => { sectionsRef.current = sections })

  const fetchSections = useCallback(async (page: number): Promise<TSection[] | null> => {
    const query = paramsRef.current.buildQuery(page)
    const result = await controllerFetch<{ sections: TSection[] }>(`${endpoint}?${query}`)
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
  }, [endpoint])

  // ── Param change: fresh page-1 fetch (sections replaced wholesale). ──
  useEffect(() => {
    const seq = ++requestSeqRef.current
    let cancelled = false
    const load = async () => {
      pageRef.current = 1
      setLoading(true)
      const fetched = await fetchSections(1)
      if (cancelled || seq !== requestSeqRef.current) return
      if (fetched !== null) setSections(fetched)
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [reloadKey, fetchSections])

  const applyFetched = useCallback((fetched: TSection[], mode: 'append' | 'refresh') => {
    setSections((prev) =>
      fetched.map((incoming) => {
        const existing = prev.find((s) => s.instanceId === incoming.instanceId)
        return foldSection(paramsRef.current, existing, incoming, mode)
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
    const fetched = await fetchSections(nextPage)
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
    let folded: TSection[] | null = null
    for (let page = 1; page <= maxPage; page++) {
      const fetched = await fetchSections(page)
      if (fetched === null || seq !== requestSeqRef.current) break
      if (folded === null) {
        folded = fetched.map((incoming) => {
          const existing = sectionsRef.current.find((s) => s.instanceId === incoming.instanceId)
          return foldSection(paramsRef.current, existing, incoming, 'refresh')
        })
      } else {
        folded = folded.map((section) => {
          const next = fetched.find((s) => s.instanceId === section.instanceId)
          return next === undefined ? section : foldSection(paramsRef.current, section, next, 'append')
        })
      }
    }
    if (folded !== null && seq === requestSeqRef.current) {
      setSections(folded.map((section) => ({ ...section, page: maxPage })))
    }
    setIsRefreshing(false)
    refreshInFlightRef.current = false
  }, [fetchSections])

  // flatItems — computed inline (dedupe + sort are trivial at panel
  // scale). The item adapters are read from the props object during
  // render — never from refs (the react-hooks/refs rule).
  const flatItems = dedupe(sections.flatMap((s) => params.getItems(s)), params.itemKey)
  if (params.sortItems != null) flatItems.sort(params.sortItems)

  const total = useMemo(() => sections.reduce((sum, s) => sum + s.total, 0), [sections])

  const hasMore = useMemo(
    () => sections.some((s) => s.hasMore && s.health === 'ok'),
    [sections],
  )

  return {
    sections,
    flatItems,
    total,
    loading,
    loadingMore,
    isRefreshing,
    error,
    refresh,
    loadMore,
    hasMore,
  }
}
