'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import type { AuditListResponse, InstanceDto } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { controllerFetch } from '@/hooks/use-controller-session'
import { formatDate, formatRelativeTime } from '@/lib/core/format'

// ============================================================
// audit-dialog.tsx — read-only audit viewer (FR-F3, §11.1)
//
// Filterable table (instance, action type) with pagination, newest
// first. No submission content ever appears here (FR-F2) — ids,
// actions, outcomes, IP only.
// ============================================================

interface AuditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instances: InstanceDto[]
}

const AUDIT_PAGE_LIMIT = 20
const ALL_FILTER = '__all__'

export function AuditDialog({ open, onOpenChange, instances }: AuditDialogProps) {
  const [instanceFilter, setInstanceFilter] = useState<string>(ALL_FILTER)
  const [actionFilter, setActionFilter] = useState<string>(ALL_FILTER)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AuditListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Loads on open + on every filter/page change.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const query = new URLSearchParams({ page: String(page), limit: String(AUDIT_PAGE_LIMIT) })
      if (instanceFilter !== ALL_FILTER) query.set('instanceId', instanceFilter)
      if (actionFilter !== ALL_FILTER) query.set('action', actionFilter)
      const result = await controllerFetch<AuditListResponse>(`/api/controller/audit?${query.toString()}`)
      if (cancelled) return
      if (result.ok && result.data != null) {
        setData(result.data)
        setError(null)
      } else {
        setError(result.error)
      }
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [open, instanceFilter, actionFilter, page])

  const totalPages = useMemo(
    () => (data != null ? Math.max(1, Math.ceil(data.total / Math.max(1, data.limit))) : 1),
    [data],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-[calc(100vw-2rem)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Log Audit</DialogTitle>
          <DialogDescription>
            Semua aksi mutasi tercatat — tanpa isi pesan (privasi: konten hanya ada di instance).
          </DialogDescription>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={instanceFilter}
            onValueChange={(value) => { setInstanceFilter(value); setPage(1) }}
          >
            <SelectTrigger aria-label="Filter instance" className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER}>Semua instance</SelectItem>
              {instances.map((instance) => (
                <SelectItem key={instance.id} value={instance.id}>{instance.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={actionFilter}
            onValueChange={(value) => { setActionFilter(value); setPage(1) }}
          >
            <SelectTrigger aria-label="Filter aksi" className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER}>Semua aksi</SelectItem>
              {(data?.actions ?? []).map((action) => (
                <SelectItem key={action} value={action}>{action}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPage((p) => Math.max(1, p - 1)) }}
              disabled={loading || page <= 1}
              aria-label="Halaman sebelumnya"
              className="size-9 p-0"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-1 text-xs text-ink-2 [font-variant-numeric:tabular-nums]">
              halaman {page}/{totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPage((p) => Math.min(totalPages, p + 1)) }}
              disabled={loading || page >= totalPages}
              aria-label="Halaman berikutnya"
              className="size-9 p-0"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="max-h-[52vh] overflow-auto rounded-lg border border-line">
          {loading && data == null ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-ink-2">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Memuat log audit…
            </div>
          ) : error != null ? (
            <p role="alert" className="m-0 px-4 py-10 text-center text-sm text-cerah-red">{error}</p>
          ) : (data?.entries.length ?? 0) === 0 ? (
            <p className="m-0 px-4 py-10 text-center text-sm text-ink-3">Belum ada entri audit.</p>
          ) : (
            <table className="w-full min-w-[720px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-line bg-cerah-surface-2 text-left text-ink-2">
                  <th scope="col" className="px-3 py-2 font-semibold">Waktu</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Instance</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Aksi</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Target</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Hasil</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Detail</th>
                  <th scope="col" className="px-3 py-2 font-semibold">IP</th>
                </tr>
              </thead>
              <tbody>
                {(data?.entries ?? []).map((entry) => (
                  <tr key={entry.id} className="border-b border-line-soft last:border-b-0">
                    <td className="px-3 py-2 whitespace-nowrap text-ink-2" title={formatDate(entry.createdAt)}>
                      {formatRelativeTime(entry.createdAt)}
                    </td>
                    <td className="max-w-32 truncate px-3 py-2 text-ink-2">{entry.instanceName ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className="rounded border border-line bg-cerah-surface-2 px-1.5 py-0.5 font-mono text-[0.65rem] text-ink">
                        {entry.action}
                      </span>
                    </td>
                    <td className="max-w-28 truncate px-3 py-2 font-mono text-[0.65rem] text-ink-2" title={entry.targetId ?? undefined}>
                      {entry.targetId ?? '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {entry.outcome === 'success' ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-cerah-green">
                          <span className="size-1.5 rounded-full bg-cerah-green-strong" aria-hidden />
                          sukses
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-medium text-cerah-red" title={entry.outcome}>
                          <span className="size-1.5 rounded-full bg-cerah-red-strong" aria-hidden />
                          error
                        </span>
                      )}
                    </td>
                    <td className="max-w-44 truncate px-3 py-2 text-ink-2" title={entry.detail ?? undefined}>
                      {entry.detail ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[0.65rem] text-ink-3">{entry.actorIp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {loading && data != null && (
          <p className="m-0 flex items-center gap-2 text-xs text-ink-3">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Memuat…
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
