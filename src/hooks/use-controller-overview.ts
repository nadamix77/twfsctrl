'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverviewResponse } from '@/lib/controller/types'
import { controllerFetch } from '@/hooks/use-controller-session'

// ============================================================
// use-controller-overview.ts — Fan-out overview (Epic C)
//
// Fetches GET /api/controller/overview and auto-refreshes every
// 60 s while the tab is visible — paused while hidden, one
// immediate refresh on re-visible (the admin stats context's
// interval + visibilitychange pattern). Partial failures keep the
// previous data (NFR-R1): the error string is exposed for a slim
// banner, the cards never blank out.
// ============================================================

export interface UseControllerOverview {
  data: OverviewResponse | null
  error: string | null
  isRefreshing: boolean
  refresh: () => Promise<void>
  lastFetchedAt: string | null
}

const OVERVIEW_INTERVAL_MS = 60_000

export function useControllerOverview(options?: {
  onUnauthorized?: () => void
}): UseControllerOverview {
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  const onUnauthorizedRef = useRef(options?.onUnauthorized)
  useEffect(() => { onUnauthorizedRef.current = options?.onUnauthorized }, [options?.onUnauthorized])

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setIsRefreshing(true)
    const result = await controllerFetch<OverviewResponse>('/api/controller/overview')
    inFlightRef.current = false
    setIsRefreshing(false)
    if (result.ok && result.data != null) {
      setData(result.data)
      setError(null)
      setLastFetchedAt(result.data.fetchedAt)
    } else {
      if (result.status === 401) onUnauthorizedRef.current?.()
      // Keep the previous payload — the dashboard degrades to stale
      // data with a banner, never a blank grid.
      setError(result.error)
    }
  }, [])

  const refreshRef = useRef(refresh)
  useEffect(() => { refreshRef.current = refresh }, [refresh])

  // Mount fetch + the 60 s visible-only interval + the re-visible
  // refresh (admin-stats-context pattern).
  useEffect(() => {
    void refreshRef.current()
    const interval = setInterval(() => {
      if (!document.hidden) void refreshRef.current()
    }, OVERVIEW_INTERVAL_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshRef.current()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  return { data, error, isRefreshing, refresh, lastFetchedAt }
}
