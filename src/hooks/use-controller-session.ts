'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControllerSessionResponse } from '@/lib/controller/types'

// ============================================================
// use-controller-session.ts — Controller auth gate (Epic A)
//
// Session check on mount, password login (401/429/503 handled),
// logout, plus the panel-wide 401 interceptor: any controller API
// answering 401 mid-session fires the registered handlers so the
// shell can re-check the session (the instance api-client
// interceptor idiom, scoped to this surface).
// ============================================================

export const CONTROLLER_GENERIC_ERROR = 'Gagal terhubung ke server'

/** Result shape for every controller fetch — never throws. */
export interface ControllerFetchResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: string | null
  retryAfterSec: number | null
}

// ── 401 interceptor ─────────────────────────────────────

type UnauthorizedHandler = () => void
const unauthorizedHandlers = new Set<UnauthorizedHandler>()

/** Register a callback fired when any controller API answers 401
 *  mid-session. Returns an unsubscribe function. */
export function onControllerUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler)
  return () => { unauthorizedHandlers.delete(handler) }
}

function notifyUnauthorized(): void {
  unauthorizedHandlers.forEach((handler) => { handler() })
}

// ── Fetch helper ────────────────────────────────────────

function readError(data: unknown, status: number): string {
  if (data != null && typeof data === 'object' && 'error' in data) {
    const err = data.error
    if (typeof err === 'string' && err.length > 0) return err
  }
  return status > 0 ? `Permintaan gagal (${status})` : CONTROLLER_GENERIC_ERROR
}

function readRetryAfter(data: unknown, res: Response): number | null {
  if (data != null && typeof data === 'object' && 'retryAfterSec' in data) {
    const raw = data.retryAfterSec
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.ceil(raw)
  }
  const header = res.headers.get('Retry-After')
  if (header != null) {
    const parsed = Number(header)
    if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed)
  }
  return null
}

/** Same-origin JSON fetch for the controller APIs. Never throws;
 *  non-2xx answers (and network failures) come back as `ok:false`
 *  with the server's verbatim error string when present.
 *  `skipUnauthorizedNotify` is for the login call itself, whose 401
 *  means "wrong password", not "session expired". */
export async function controllerFetch<T>(
  path: string,
  init?: RequestInit,
  opts?: { skipUnauthorizedNotify?: boolean },
): Promise<ControllerFetchResult<T>> {
  try {
    const headers: Record<string, string> = {}
    if (init?.body != null) headers['Content-Type'] = 'application/json'
    const res = await fetch(path, { ...init, credentials: 'same-origin', headers })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      // non-JSON body (proxied bytes, HTML error pages) — readError falls back
    }
    if (!res.ok) {
      if (res.status === 401 && opts?.skipUnauthorizedNotify !== true) notifyUnauthorized()
      return {
        ok: false,
        status: res.status,
        data: null,
        error: readError(data, res.status),
        retryAfterSec: readRetryAfter(data, res),
      }
    }
    return { ok: true, status: res.status, data: data as T, error: null, retryAfterSec: null }
  } catch {
    return { ok: false, status: 0, data: null, error: CONTROLLER_GENERIC_ERROR, retryAfterSec: null }
  }
}

// ── Session hook ────────────────────────────────────────

/** What login() reports back to the screen: the verbatim server error
 *  (null on success) plus the 429 lockout seconds when present. */
export interface ControllerLoginResult {
  error: string | null
  retryAfterSec: number | null
}

export interface UseControllerSession {
  session: ControllerSessionResponse | null
  loading: boolean
  login: (password: string) => Promise<ControllerLoginResult>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export function useControllerSession(): UseControllerSession {
  const [session, setSession] = useState<ControllerSessionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef<ControllerSessionResponse | null>(null)
  useEffect(() => { sessionRef.current = session }, [session])

  /** Re-check the session. A transient network failure keeps whatever
   *  state we had — only a real answer flips the gate. When the session
   *  is unknown (boot failure / retry), the check re-arms the loading
   *  spinner so the retry button gives feedback. */
  const refresh = useCallback(async () => {
    const recheck = sessionRef.current === null
    if (recheck) setLoading(true)
    const result = await controllerFetch<ControllerSessionResponse>('/api/controller/session')
    if (result.ok && result.data != null) setSession(result.data)
    setLoading(false)
  }, [])

  // Session check on mount.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const result = await controllerFetch<ControllerSessionResponse>('/api/controller/session')
      if (cancelled) return
      if (result.ok && result.data != null) setSession(result.data)
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [])

  // Mid-session 401 from any controller API → re-check the session.
  // When the cookie is really gone the answer flips the gate to the
  // login screen; a spurious 401 keeps the operator logged in.
  useEffect(() => onControllerUnauthorized(() => { void refresh() }), [refresh])

  const login = useCallback(async (password: string): Promise<ControllerLoginResult> => {
    const result = await controllerFetch<{ success: boolean }>(
      '/api/controller/login',
      { method: 'POST', body: JSON.stringify({ password }) },
      { skipUnauthorizedNotify: true },
    )
    if (result.ok) {
      await refresh()
      return { error: null, retryAfterSec: null }
    }
    return { error: result.error, retryAfterSec: result.retryAfterSec }
  }, [refresh])

  const logout = useCallback(async () => {
    await controllerFetch<{ success: boolean }>('/api/controller/logout', { method: 'POST' })
    await refresh()
  }, [refresh])

  return { session, loading, login, logout, refresh }
}
