'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BadgeCheck,
  Eraser,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type {
  AiSnapshot,
  FilterSettingsSnapshot,
  InstanceDto,
  QuickActionResponse,
  SettingRow,
  SettingsSnapshot,
} from '@/lib/controller/types'
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
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { controllerFetch } from '@/hooks/use-controller-session'
import { formatRelativeTime } from '@/lib/core/format'
import { cn } from '@/lib/core/utils'

// ============================================================
// instance-settings-dialog.tsx — per-instance Pengaturan dialog
//
// Three tabs proxying the instance's own admin settings:
//   Kredensial & X — scalar settings (masked reads, upsert/delete)
//   Filter         — the batched filter-settings patch form
//   AI             — provider health probe + decision stats
//
// The controller stores NOTHING: every read is live, every write
// forwards to the instance and toasts its verbatim copy.
// ============================================================

interface InstanceSettingsDialogProps {
  instance: InstanceDto | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUnauthorized: () => void
}

/** The 16 scalar keys the instance accepts (INSTANCE-API §settings). */
const SETTING_LABELS = new Map<string, string>([
  ['x_cookie_string', 'Cookie X (direct)'],
  ['x_bearer_token', 'Bearer Token X'],
  ['twitterapi_keys', 'Kunci TwitterAPI'],
  ['twitterapi_proxy', 'Proxy TwitterAPI'],
  ['post_method', 'Metode Posting'],
  ['x_username', 'Username X (login V2)'],
  ['x_email', 'Email X (login V2)'],
  ['x_password', 'Password X (login V2)'],
  ['x_totp_secret', 'Secret TOTP X (login V2)'],
  ['twitterapi_login_cookie', 'Cookie Login TwitterAPI'],
  ['v2_login_enabled', 'Login V2 Aktif'],
  ['post_hashtags', 'Hashtag Posting'],
  ['require_follow', 'Wajib Follow'],
  ['gobiz_session_token', 'Token Sesi GoBiz'],
  ['gobiz_refresh_token', 'Refresh Token GoBiz'],
  ['merchants_static_qris', 'QRIS Statis Merchant'],
])

function labelOf(key: string): string {
  return SETTING_LABELS.get(key) ?? key
}

/** SAST-clean dynamic lookup on a Record (entries-find). */
function lookupNumber(record: Record<string, number> | null, key: string): number | null {
  if (record == null) return null
  const entry = Object.entries(record).find(([k]) => k === key)
  return entry != null && typeof entry[1] === 'number' ? entry[1] : null
}

export function InstanceSettingsDialog({ instance, open, onOpenChange, onUnauthorized }: InstanceSettingsDialogProps) {
  if (instance == null) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="flex flex-col gap-1 border-b border-line px-6 pb-3 pt-5">
          <DialogHeader className="space-y-0">
            <DialogTitle className="flex items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full border border-line"
                style={instance.colorTag != null ? { backgroundColor: instance.colorTag } : { backgroundColor: 'var(--surface-3)' }}
                aria-hidden
              />
              Pengaturan — {instance.name}
            </DialogTitle>
            <DialogDescription>
              Semua perubahan diteruskan ke instance {instance.baseUrl} — controller tidak menyimpan salinannya.
            </DialogDescription>
          </DialogHeader>
        </div>
        <Tabs defaultValue="credentials" className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="border-b border-line px-6">
            <TabsList className="h-auto w-full justify-start gap-1 bg-transparent p-0">
              <TabsTrigger value="credentials" className="gap-1.5 px-3 py-2 text-xs">Kredensial &amp; X</TabsTrigger>
              <TabsTrigger value="filter" className="gap-1.5 px-3 py-2 text-xs">Filter</TabsTrigger>
              <TabsTrigger value="ai" className="gap-1.5 px-3 py-2 text-xs">AI</TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <TabsContent value="credentials" className="mt-0">
              <CredentialsTab instance={instance} onUnauthorized={onUnauthorized} />
            </TabsContent>
            <TabsContent value="filter" className="mt-0">
              <FilterTab instance={instance} onUnauthorized={onUnauthorized} />
            </TabsContent>
            <TabsContent value="ai" className="mt-0">
              <AiTab instance={instance} onUnauthorized={onUnauthorized} />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ── Shared fetch helpers ────────────────────────────────────

function useUnauthorizedRef(onUnauthorized: () => void) {
  const ref = useRef(onUnauthorized)
  useEffect(() => { ref.current = onUnauthorized }, [onUnauthorized])
  return ref
}

// ── Tab 1: Kredensial & X ───────────────────────────────────

function CredentialsTab({ instance, onUnauthorized }: { instance: InstanceDto; onUnauthorized: () => void }) {
  const { toast } = useToast()
  const onUnauthorizedRef = useUnauthorizedRef(onUnauthorized)
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Initial fetch — setStates only after the await (the effect-lint
  // rule forbids synchronous setState); manual reloads set loading in
  // their event handlers instead.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const result = await controllerFetch<SettingsSnapshot>(
        `/api/controller/settings/${encodeURIComponent(instance.id)}`,
      )
      if (cancelled) return
      if (result.status === 401) {
        onUnauthorizedRef.current()
        return
      }
      if (result.ok && result.data != null) {
        setSnapshot(result.data)
        setError(null)
      } else {
        setError(result.error)
      }
      setLoading(false)
    }
    void run()
    return () => { cancelled = true }
  }, [instance.id, onUnauthorizedRef])

  /** Manual reload (after saves) — event-handler context, so a
   *  synchronous loading flip is fine here. */
  const reload = useCallback(async () => {
    setLoading(true)
    const result = await controllerFetch<SettingsSnapshot>(
      `/api/controller/settings/${encodeURIComponent(instance.id)}`,
    )
    if (result.status === 401) {
      onUnauthorizedRef.current()
      return
    }
    if (result.ok && result.data != null) {
      setSnapshot(result.data)
      setError(null)
    } else {
      setError(result.error)
    }
    setLoading(false)
  }, [instance.id, onUnauthorizedRef])

  const [newKey, setNewKey] = useState<string>('')
  const [newValue, setNewValue] = useState('')
  const [savingNew, setSavingNew] = useState(false)

  const [editKey, setEditKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SettingRow | null>(null)
  const [busy, setBusy] = useState(false)

  const save = useCallback(async (key: string, value: string) => {
    if (busy) return
    setBusy(true)
    const result = await controllerFetch<QuickActionResponse>(
      `/api/controller/settings/${encodeURIComponent(instance.id)}`,
      { method: 'POST', body: JSON.stringify({ key, value }) },
    )
    setBusy(false)
    if (result.status === 401) {
      onUnauthorizedRef.current()
      return false
    }
    const envelope = result.data
    if (result.ok && envelope != null && envelope.ok) {
      toast({ title: `${labelOf(key)} disimpan` })
      void reload()
      return true
    }
    toast({ title: envelope?.error ?? result.error ?? 'Gagal menyimpan setting', variant: 'destructive' })
    return false
  }, [busy, instance.id, reload, onUnauthorizedRef, toast])

  const remove = useCallback(async (key: string) => {
    if (busy) return
    setBusy(true)
    const result = await controllerFetch<QuickActionResponse>(
      `/api/controller/settings/${encodeURIComponent(instance.id)}?key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    )
    setBusy(false)
    if (result.status === 401) {
      onUnauthorizedRef.current()
      return
    }
    const envelope = result.data
    if (result.ok && envelope != null && envelope.ok) {
      toast({ title: `${labelOf(key)} dihapus` })
      void reload()
    } else {
      toast({ title: envelope?.error ?? result.error ?? 'Gagal menghapus setting', variant: 'destructive' })
    }
  }, [busy, instance.id, reload, onUnauthorizedRef, toast])

  const saveNew = async () => {
    const value = newValue.trim()
    if (newKey.length === 0) {
      toast({ title: 'Pilih kunci terlebih dahulu', variant: 'destructive' })
      return
    }
    if (value.length === 0) {
      toast({ title: 'Nilai tidak boleh kosong', variant: 'destructive' })
      return
    }
    setSavingNew(true)
    const ok = await save(newKey, value)
    setSavingNew(false)
    if (ok) {
      setNewKey('')
      setNewValue('')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Add / update form */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-cerah-surface-2/60 p-3">
        <p className="m-0 flex items-center gap-1.5 text-xs font-bold text-ink">
          <Plus className="size-3.5" aria-hidden />
          Tambah / perbarui kunci
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={newKey} onValueChange={setNewKey}>
            <SelectTrigger aria-label="Kunci setting" className="h-9 w-full sm:w-[240px] text-xs">
              <SelectValue placeholder="Pilih kunci…" />
            </SelectTrigger>
            <SelectContent>
              {[...SETTING_LABELS.entries()].map(([key, label]) => (
                <SelectItem key={key} value={key} className="text-xs">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Nilai setting"
            value={newValue}
            onChange={(e) => { setNewValue(e.target.value) }}
            placeholder="Nilai baru (menimpa yang lama)"
            className="h-9 flex-1 text-xs"
          />
          <Button
            size="sm"
            onClick={() => { void saveNew() }}
            disabled={busy || savingNew}
            className="h-9 shrink-0 px-3 text-xs"
          >
            {(busy || savingNew) && <Loader2 className="size-3.5 animate-spin" />}
            Simpan
          </Button>
        </div>
      </div>

      {/* Current rows */}
      {loading ? (
        <div className="flex flex-col gap-2" aria-label="Memuat pengaturan">
          {Array.from({ length: 4 }, (_, i) => <span key={i} className="cerah-skeleton h-14 rounded-xl" />)}
        </div>
      ) : error != null ? (
        <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Pengaturan tidak dapat dimuat: {error}
        </p>
      ) : (snapshot?.settings.length ?? 0) === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-ink-3">
          Belum ada kunci yang disimpan di instance ini.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {snapshot?.settings.map((row) => (
            <li key={row.key} className="rounded-xl border border-line bg-surface px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="m-0 flex items-center gap-1.5 text-xs font-bold text-ink">
                    <KeyRound className="size-3 shrink-0 text-ink-3" aria-hidden />
                    {labelOf(row.key)}
                  </p>
                  <p className="m-0 mt-0.5 truncate font-mono text-[0.7rem] text-ink-3">
                    {row.key} = {row.value}
                    {row.updatedAt != null && ` · diubah ${formatRelativeTime(row.updatedAt)}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {editKey === row.key ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => { setEditKey(row.key); setEditValue('') }}
                      aria-label={`Perbarui ${labelOf(row.key)}`}
                      className="size-9 p-0 text-ink-3 hover:text-ink"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => { setDeleteTarget(row) }}
                    aria-label={`Hapus ${labelOf(row.key)}`}
                    className="size-9 p-0 text-ink-3 hover:text-cerah-red"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              {editKey === row.key && (
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <Input
                    aria-label={`Nilai baru untuk ${labelOf(row.key)}`}
                    value={editValue}
                    onChange={(e) => { setEditValue(e.target.value) }}
                    placeholder="Nilai pengganti (nilai lama tidak pernah ditampilkan)"
                    className="h-9 flex-1 text-xs"
                    autoFocus
                  />
                  <div className="flex shrink-0 gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => { setEditKey(null) }} disabled={busy} className="h-9 px-3 text-xs">
                      Batal
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || editValue.trim().length === 0}
                      onClick={() => {
                        void (async () => {
                          const ok = await save(row.key, editValue.trim())
                          if (ok) setEditKey(null)
                        })()
                      }}
                      className="h-9 px-3 text-xs"
                    >
                      {busy && <Loader2 className="size-3.5 animate-spin" />}
                      Simpan
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Encryption note */}
      {snapshot?.encryptionEnabled != null && (
        <p className={cn('m-0 flex items-center gap-1.5 text-[0.7rem]', snapshot.encryptionEnabled ? 'text-ink-3' : 'text-cerah-amber-strong')}>
          {snapshot.encryptionEnabled
            ? <><ShieldCheck className="size-3.5 shrink-0" aria-hidden /> Nilai kunci dienkripsi oleh instance.</>
            : <><AlertTriangle className="size-3.5 shrink-0" aria-hidden /> Enkripsi nonaktif di instance — kredensial disimpan apa adanya.</>}
        </p>
      )}

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget != null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus kunci ini?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget != null && (
                <>
                  <span className="font-semibold">{labelOf(deleteTarget.key)}</span> dihapus dari instance{' '}
                  {instance.name}. Fungsinya yang bergantung pada kunci ini akan berhenti bekerja.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-cerah-red text-white hover:bg-cerah-red-strong"
              onClick={() => {
                if (deleteTarget != null) void remove(deleteTarget.key)
                setDeleteTarget(null)
              }}
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Tab 2: Filter ───────────────────────────────────────────

const IMAGE_MODES = new Map<string, string>([
  ['everyone', 'Semua orang'],
  ['allowlist', 'Hanya allowlist'],
  ['nobody', 'Dinonaktifkan'],
])

/** Numeric field with string state + initial value comparison. */
function NumField({
  id,
  label,
  initial,
  onRaw,
}: {
  id: string
  label: string
  initial: number | null
  onRaw: (id: string, raw: string) => void
}) {
  const [value, setValue] = useState('')
  const hint = initial != null ? `saat ini ${initial}` : '—'
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`fs-${id}`} className="text-xs font-medium text-ink-2">{label}</label>
      <Input
        id={`fs-${id}`}
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          onRaw(id, e.target.value)
        }}
        placeholder={hint}
        className="h-9"
      />
    </div>
  )
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={`fs-${id}`} className="text-xs font-semibold text-ink">{label}</label>
        <p className="m-0 text-[0.7rem] leading-snug text-ink-3">{description}</p>
      </div>
      <Switch id={`fs-${id}`} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function FilterTab({ instance, onUnauthorized }: { instance: InstanceDto; onUnauthorized: () => void }) {
  const { toast } = useToast()
  const onUnauthorizedRef = useUnauthorizedRef(onUnauthorized)
  const [snapshot, setSnapshot] = useState<FilterSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Form state (initialized from the snapshot once loaded).
  const [autoApprove, setAutoApprove] = useState(false)
  const [requireFollow, setRequireFollow] = useState(false)
  const [postingGuidelinesEnabled, setPostingGuidelinesEnabled] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [pointsEnabled, setPointsEnabled] = useState(false)
  const [imagePostingMode, setImagePostingMode] = useState<string>('everyone')
  const [blockedWords, setBlockedWords] = useState('')
  const [nsfwWords, setNsfwWords] = useState('')
  const [aiSystemPrompt, setAiSystemPrompt] = useState('')
  const [aiImageSystemPrompt, setAiImageSystemPrompt] = useState('')
  const numValues = useRef(new Map<string, string>())

  /** Apply one fetched snapshot to the form (called after awaits only). */
  const applySnapshot = (data: FilterSettingsSnapshot | null, err: string | null) => {
    if (data != null) {
      setSnapshot(data)
      // Initialize the form from the snapshot.
      setAutoApprove(data.autoApprove ?? false)
      setRequireFollow(data.requireFollow ?? false)
      setPostingGuidelinesEnabled(data.postingGuidelinesEnabled ?? false)
      setAiEnabled(data.aiEnabled ?? false)
      setPointsEnabled(data.monetization?.pointsEnabled === true)
      setImagePostingMode(data.imagePostingMode ?? 'everyone')
      setBlockedWords(data.blockedWords.join('\n'))
      setNsfwWords(data.nsfwWords.join('\n'))
      setAiSystemPrompt(data.aiSystemPrompt ?? '')
      setAiImageSystemPrompt(data.aiImageSystemPrompt ?? '')
      numValues.current.clear()
      setError(null)
    } else {
      setError(err ?? 'instance tidak menjawab')
    }
    setLoading(false)
  }

  // Initial fetch — setStates only after the await (effect-lint rule).
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const result = await controllerFetch<FilterSettingsSnapshot>(
        `/api/controller/filter-settings/${encodeURIComponent(instance.id)}`,
      )
      if (cancelled) return
      if (result.status === 401) {
        onUnauthorizedRef.current()
        return
      }
      applySnapshot(result.ok && result.data != null ? result.data : null, result.ok ? null : result.error)
    }
    void run()
    return () => { cancelled = true }
  }, [instance.id, onUnauthorizedRef])

  /** Manual reload (Muat ulang / after save) — event-handler context. */
  const reload = useCallback(async () => {
    setLoading(true)
    const result = await controllerFetch<FilterSettingsSnapshot>(
      `/api/controller/filter-settings/${encodeURIComponent(instance.id)}`,
    )
    if (result.status === 401) {
      onUnauthorizedRef.current()
      return
    }
    applySnapshot(result.ok && result.data != null ? result.data : null, result.ok ? null : result.error)
  }, [instance.id, onUnauthorizedRef])

  const handleNum = useCallback((id: string, raw: string) => {
    const trimmed = raw.trim()
    if (trimmed.length === 0) numValues.current.delete(id)
    else numValues.current.set(id, trimmed)
  }, [])

  const save = async () => {
    if (snapshot == null) return
    const patch: Record<string, unknown> = {}

    if (autoApprove !== (snapshot.autoApprove ?? false)) patch.autoApprove = autoApprove
    if (requireFollow !== (snapshot.requireFollow ?? false)) patch.requireFollow = requireFollow
    if (postingGuidelinesEnabled !== (snapshot.postingGuidelinesEnabled ?? false)) {
      patch.postingGuidelinesEnabled = postingGuidelinesEnabled
    }
    if (aiEnabled !== (snapshot.aiEnabled ?? false)) patch.aiEnabled = aiEnabled

    const blockedList = blockedWords.split('\n').map((w) => w.trim()).filter((w) => w.length > 0)
    if (blockedList.join('\n') !== snapshot.blockedWords.join('\n')) patch.blockedWords = blockedList
    const nsfwList = nsfwWords.split('\n').map((w) => w.trim()).filter((w) => w.length > 0)
    if (nsfwList.join('\n') !== snapshot.nsfwWords.join('\n')) patch.nsfwWords = nsfwList

    if (aiSystemPrompt !== (snapshot.aiSystemPrompt ?? '')) patch.aiSystemPrompt = aiSystemPrompt
    if (aiImageSystemPrompt !== (snapshot.aiImageSystemPrompt ?? '')) patch.aiImageSystemPrompt = aiImageSystemPrompt

    if (imagePostingMode !== (snapshot.imagePostingMode ?? 'everyone')) patch.imagePostingMode = imagePostingMode

    // Numeric groups — only the touched keys, merged into partial groups.
    // Entries + fromEntries — no computed member writes (SAST idiom).
    const rateLimits: Array<[string, number]> = []
    const circuitBreaker: Array<[string, number]> = []
    const monetization: Array<[string, number | boolean]> = []

    const RATE_KEYS = ['submissionCooldown', 'submissionDailyCap', 'userPendingCap', 'userPostDailyCap']
    for (const key of RATE_KEYS) {
      const raw = numValues.current.get(key)
      if (raw == null) continue
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast({ title: 'Nilai batas harus bilangan bulat ≥ 0', variant: 'destructive' })
        return
      }
      rateLimits.push([key, parsed])
    }

    const rawThreshold = numValues.current.get('circuitBreakerThreshold')
    if (rawThreshold != null) {
      const parsed = Number(rawThreshold)
      if (!Number.isInteger(parsed) || parsed < 1) {
        toast({ title: 'Ambang circuit breaker harus bilangan bulat ≥ 1', variant: 'destructive' })
        return
      }
      circuitBreaker.push(['circuitBreakerThreshold', parsed])
    }

    if (pointsEnabled !== (snapshot.monetization?.pointsEnabled === true)) {
      monetization.push(['pointsEnabled', pointsEnabled])
    }
    for (const key of ['pricePerPointIdr', 'topupBonusPercent', 'unblockFeeIdr']) {
      const raw = numValues.current.get(key)
      if (raw == null) continue
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast({ title: 'Nilai monetisasi harus bilangan bulat ≥ 0', variant: 'destructive' })
        return
      }
      monetization.push([key, parsed])
    }

    if (rateLimits.length > 0) patch.rateLimits = Object.fromEntries(rateLimits)
    if (circuitBreaker.length > 0) patch.circuitBreaker = Object.fromEntries(circuitBreaker)
    if (monetization.length > 0) patch.monetization = Object.fromEntries(monetization)

    if (Object.keys(patch).length === 0) {
      toast({ title: 'Tidak ada perubahan untuk disimpan' })
      return
    }

    setSaving(true)
    const result = await controllerFetch<QuickActionResponse>(
      `/api/controller/filter-settings/${encodeURIComponent(instance.id)}`,
      { method: 'POST', body: JSON.stringify(patch) },
    )
    setSaving(false)
    if (result.status === 401) {
      onUnauthorizedRef.current()
      return
    }
    const envelope = result.data
    if (result.ok && envelope != null && envelope.ok) {
      toast({ title: 'Pengaturan filter disimpan', description: `${Object.keys(patch).length} grup diperbarui.` })
      void reload()
    } else {
      toast({ title: envelope?.error ?? result.error ?? 'Gagal menyimpan pengaturan filter', variant: 'destructive' })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-label="Memuat pengaturan filter">
        {Array.from({ length: 6 }, (_, i) => <span key={i} className="cerah-skeleton h-12 rounded-xl" />)}
      </div>
    )
  }
  if (error != null || snapshot == null) {
    return (
      <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Pengaturan filter tidak dapat dimuat: {error ?? 'instance tidak menjawab'}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[0.7rem] leading-relaxed text-ink-3">
        Hanya field yang diubah yang dikirim sebagai patch — sisanya dibiarkan apa adanya di instance.
      </p>

      {/* Switches */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-cerah-surface-2/60 p-3 sm:grid-cols-2">
        <SwitchRow
          id="auto-approve"
          label="Auto-approve"
          description="Submission lolos otomatis tanpa review manual."
          checked={autoApprove}
          onCheckedChange={setAutoApprove}
        />
        <SwitchRow
          id="require-follow"
          label="Wajib follow"
          description="Pengirim wajib meng-follow akun menfess."
          checked={requireFollow}
          onCheckedChange={setRequireFollow}
        />
        <SwitchRow
          id="guidelines"
          label="Panduan posting"
          description="Tampilkan panduan apa yang boleh/tidak di form kirim."
          checked={postingGuidelinesEnabled}
          onCheckedChange={setPostingGuidelinesEnabled}
        />
        <SwitchRow
          id="ai-enabled"
          label="Moderasi AI"
          description="Pesan diperiksa penyedia AI sebelum masuk antrean."
          checked={aiEnabled}
          onCheckedChange={setAiEnabled}
        />
      </div>

      {/* Word lists */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="fs-blocked" className="text-xs font-semibold text-ink-2">Kata diblokir (satu per baris)</label>
          <Textarea
            id="fs-blocked"
            value={blockedWords}
            onChange={(e) => { setBlockedWords(e.target.value) }}
            rows={5}
            placeholder={'spam\njudol'}
            className="text-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="fs-nsfw" className="text-xs font-semibold text-ink-2">Kata NSFW (satu per baris)</label>
          <Textarea
            id="fs-nsfw"
            value={nsfwWords}
            onChange={(e) => { setNsfwWords(e.target.value) }}
            rows={5}
            placeholder="kosong = nonaktif"
            className="text-xs"
          />
        </div>
      </div>

      {/* AI prompts */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="fs-ai-prompt" className="text-xs font-semibold text-ink-2">System prompt AI (teks)</label>
          <Textarea
            id="fs-ai-prompt"
            value={aiSystemPrompt}
            onChange={(e) => { setAiSystemPrompt(e.target.value) }}
            rows={3}
            placeholder="kosong = pakai default instance"
            className="text-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="fs-ai-img-prompt" className="text-xs font-semibold text-ink-2">System prompt AI (gambar)</label>
          <Textarea
            id="fs-ai-img-prompt"
            value={aiImageSystemPrompt}
            onChange={(e) => { setAiImageSystemPrompt(e.target.value) }}
            rows={3}
            placeholder="kosong = pakai default instance"
            className="text-xs"
          />
        </div>
      </div>

      {/* Image posting mode */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="fs-image-mode" className="text-xs font-semibold text-ink-2">Mode kirim gambar</label>
        <Select value={imagePostingMode} onValueChange={setImagePostingMode}>
          <SelectTrigger id="fs-image-mode" className="h-9 w-full text-xs sm:w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...IMAGE_MODES.entries()].map(([value, label]) => (
              <SelectItem key={value} value={value} className="text-xs">{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Rate limits */}
      <fieldset className="m-0 flex flex-col gap-2.5 rounded-xl border border-line bg-cerah-surface-2/60 p-3">
        <legend className="px-1 text-xs font-bold text-ink">Batas pengiriman</legend>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <NumField id="submissionCooldown" label="Cooldown (menit)" initial={lookupNumber(snapshot.rateLimits, 'submissionCooldown')} onRaw={handleNum} />
          <NumField id="submissionDailyCap" label="Batas kirim / hari" initial={lookupNumber(snapshot.rateLimits, 'submissionDailyCap')} onRaw={handleNum} />
          <NumField id="userPendingCap" label="Batas pending" initial={lookupNumber(snapshot.rateLimits, 'userPendingCap')} onRaw={handleNum} />
          <NumField id="userPostDailyCap" label="Batas posting / hari" initial={lookupNumber(snapshot.rateLimits, 'userPostDailyCap')} onRaw={handleNum} />
        </div>
      </fieldset>

      {/* Circuit breaker + monetization */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <fieldset className="m-0 flex flex-col gap-2.5 rounded-xl border border-line bg-cerah-surface-2/60 p-3">
          <legend className="px-1 text-xs font-bold text-ink">Circuit breaker</legend>
          <NumField id="circuitBreakerThreshold" label="Ambang kegagalan" initial={lookupNumber(snapshot.circuitBreaker, 'circuitBreakerThreshold')} onRaw={handleNum} />
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2.5 rounded-xl border border-line bg-cerah-surface-2/60 p-3">
          <legend className="px-1 text-xs font-bold text-ink">Monetisasi</legend>
          <SwitchRow
            id="points-enabled"
            label="Poin aktif"
            description="Submission berbayar memakai poin."
            checked={pointsEnabled}
            onCheckedChange={setPointsEnabled}
          />
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <NumField id="pricePerPointIdr" label="Harga / poin (Rp)" initial={lookupNumber(snapshot.monetization as Record<string, number> | null, 'pricePerPointIdr')} onRaw={handleNum} />
            <NumField id="topupBonusPercent" label="Bonus top-up (%)" initial={lookupNumber(snapshot.monetization as Record<string, number> | null, 'topupBonusPercent')} onRaw={handleNum} />
            <NumField id="unblockFeeIdr" label="Biaya buka blokir (Rp)" initial={lookupNumber(snapshot.monetization as Record<string, number> | null, 'unblockFeeIdr')} onRaw={handleNum} />
          </div>
        </fieldset>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => { void reload() }} disabled={saving} className="text-xs">
          <RefreshCw className="size-3.5" />
          Muat ulang
        </Button>
        <Button onClick={() => { void save() }} disabled={saving} className="text-xs">
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Simpan Perubahan
        </Button>
      </div>
    </div>
  )
}

// ── Tab 3: AI ───────────────────────────────────────────────

function AiTab({ instance, onUnauthorized }: { instance: InstanceDto; onUnauthorized: () => void }) {
  const onUnauthorizedRef = useUnauthorizedRef(onUnauthorized)
  const [snapshot, setSnapshot] = useState<AiSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  const applyResult = (result: Awaited<ReturnType<typeof controllerFetch<AiSnapshot>>>) => {
    if (result.ok && result.data != null) {
      setSnapshot(result.data)
    } else {
      setSnapshot({ status: null, statusError: result.error, stats: null, statsError: result.error })
    }
    setLoading(false)
  }

  // Initial fetch — setStates only after the await (effect-lint rule).
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const result = await controllerFetch<AiSnapshot>(
        `/api/controller/ai/${encodeURIComponent(instance.id)}`,
      )
      if (cancelled) return
      if (result.status === 401) {
        onUnauthorizedRef.current()
        return
      }
      applyResult(result)
    }
    void run()
    return () => { cancelled = true }
  }, [instance.id, onUnauthorizedRef])

  /** Manual reload (Periksa ulang) — event-handler context. */
  const reload = useCallback(async () => {
    setLoading(true)
    const result = await controllerFetch<AiSnapshot>(
      `/api/controller/ai/${encodeURIComponent(instance.id)}`,
    )
    if (result.status === 401) {
      onUnauthorizedRef.current()
      return
    }
    applyResult(result)
  }, [instance.id, onUnauthorizedRef])

  const status = snapshot?.status ?? null
  const stats = snapshot?.stats ?? null
  const statsRows = useMemo(() => stats?.rows ?? [], [stats])

  return (
    <div className="flex flex-col gap-4">
      {/* Provider health */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-cerah-surface-2/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 flex items-center gap-1.5 text-xs font-bold text-ink">
            <Sparkles className="size-3.5 text-ink-3" aria-hidden />
            Kesehatan penyedia AI
          </p>
          <div className="flex items-center gap-2">
            {status?.healthy != null && (
              <Badge
                variant="outline"
                className={cn(
                  'px-2 py-0.5 text-[10px]',
                  status.healthy
                    ? 'border-cerah-green-line bg-cerah-green-soft text-cerah-green'
                    : 'border-cerah-red-line bg-cerah-red-soft text-cerah-red',
                )}
              >
                {status.healthy ? 'Sehat' : 'Tidak sehat'}
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={() => { void reload() }} disabled={loading} className="h-8 px-2.5 text-[0.7rem]">
              {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Periksa ulang
            </Button>
          </div>
        </div>

        {loading && snapshot == null ? (
          <div className="flex flex-col gap-2" aria-label="Memeriksa penyedia AI">
            {Array.from({ length: 2 }, (_, i) => <span key={i} className="cerah-skeleton h-10 rounded-lg" />)}
          </div>
        ) : snapshot?.statusError != null && status == null ? (
          <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg border border-cerah-red-line bg-cerah-red-soft px-3 py-2 text-xs leading-relaxed text-cerah-red">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Status AI tidak dapat dimuat: {snapshot.statusError}
          </p>
        ) : (status?.providers.length ?? 0) === 0 ? (
          <p className="m-0 text-xs text-ink-3">Belum ada penyedia AI yang dikonfigurasi di instance ini.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {status?.providers.map((provider) => (
              <li key={provider.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2">
                <div className="min-w-0">
                  <p className="m-0 text-xs font-bold text-ink">
                    {provider.name ?? provider.id}
                    {provider.model != null && <span className="ml-1.5 font-mono text-[0.65rem] font-normal text-ink-3">{provider.model}</span>}
                  </p>
                  {provider.error != null && (
                    <p className="m-0 mt-0.5 text-[0.7rem] text-cerah-red">{provider.error}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {provider.enabled != null && (
                    <Badge variant="outline" className={cn('px-2 py-0 text-[10px]', provider.enabled ? 'border-xblue-line bg-xblue-soft text-xblue-ink' : 'border-line bg-cerah-surface-2 text-ink-3')}>
                      {provider.enabled ? 'aktif' : 'nonaktif'}
                    </Badge>
                  )}
                  {provider.healthy != null && (
                    <Badge variant="outline" className={cn('px-2 py-0 text-[10px]', provider.healthy ? 'border-cerah-green-line bg-cerah-green-soft text-cerah-green' : 'border-cerah-red-line bg-cerah-red-soft text-cerah-red')}>
                      {provider.healthy ? <BadgeCheck className="size-2.5" /> : <AlertTriangle className="size-2.5" />}
                      {provider.healthy ? 'sehat' : 'gagal'}
                    </Badge>
                  )}
                  {provider.latencyMs != null && (
                    <span className="text-[0.65rem] text-ink-3 [font-variant-numeric:tabular-nums]">{provider.latencyMs} ms</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Decision stats */}
      <div className="flex flex-col gap-2.5">
        <p className="m-0 flex items-center gap-1.5 text-xs font-bold text-ink">
          <Eraser className="size-3.5 text-ink-3" aria-hidden />
          Statistik keputusan AI
          {stats?.windowHours != null && (
            <span className="font-normal text-ink-3">· jendela {stats.windowHours} jam</span>
          )}
        </p>

        {snapshot?.statsError != null && stats == null ? (
          <p className="m-0 rounded-lg border border-cerah-amber-line bg-cerah-amber-soft px-3 py-2 text-xs text-cerah-amber-strong">
            Statistik tidak tersedia: {snapshot.statsError}
          </p>
        ) : statsRows.length === 0 ? (
          <p className="m-0 text-xs text-ink-3">Belum ada keputusan AI yang tercatat pada jendela berjalan.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[520px] border-collapse text-left text-xs">
              <caption className="sr-only">Statistik keputusan AI per fase, penyedia, dan model</caption>
              <thead>
                <tr className="border-b border-line bg-cerah-surface-2 text-[0.7rem] text-ink-2">
                  <th scope="col" className="px-3 py-2 font-semibold">Fase</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Penyedia / model</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Panggilan</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Lolos</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">p50/p95</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Token</th>
                </tr>
              </thead>
              <tbody>
                {statsRows.map((row, i) => (
                  <tr key={`${row.phase}-${row.provider}-${i}`} className="border-b border-line-soft last:border-b-0">
                    <td className="px-3 py-2 font-semibold text-ink">{row.phase}</td>
                    <td className="px-3 py-2 text-ink-2">
                      {row.provider}
                      {row.model != null && <span className="ml-1 font-mono text-[0.65rem] text-ink-3">{row.model}</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 [font-variant-numeric:tabular-nums]">{row.totalCalls}</td>
                    <td className="px-3 py-2 text-right text-ink-2 [font-variant-numeric:tabular-nums]">
                      {row.passRatePct != null ? `${row.passRatePct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 [font-variant-numeric:tabular-nums]">
                      {row.p50LatencyMs != null || row.p95LatencyMs != null
                        ? `${row.p50LatencyMs ?? '—'}/${row.p95LatencyMs ?? '—'} ms`
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 [font-variant-numeric:tabular-nums]">
                      {row.avgTotalTokens != null ? `~${row.avgTotalTokens}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
