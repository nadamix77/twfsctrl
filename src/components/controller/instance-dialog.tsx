'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, PlugZap } from 'lucide-react'
import type {
  ConnectionTestResult,
  InstanceCreateInput,
  InstanceDto,
  InstanceUpdateInput,
} from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SecretInput } from '@/components/shared/secret-input'
import { useCountdownFromSeconds } from '@/hooks/use-countdown'
import { useToast } from '@/hooks/use-toast'
import { controllerFetch } from '@/hooks/use-controller-session'
import { formatMmSs } from '@/lib/core/format'
import { cn } from '@/lib/core/utils'

// ============================================================
// instance-dialog.tsx — add/edit instance (FR-B1/B3, §11.1)
//
// Registry form + the FR-B2 connectivity test (login + session
// read against the instance, result + pending count inline). In
// create mode the save is gated on a PASSING test or the explicit
// E10 override; in edit mode the URL is immutable and the password
// is optional (blank = keep existing).
//
// The form itself is a child of DialogContent: Radix unmounts the
// content when the dialog closes, so every open cycle starts from
// fresh useState seeds (no reset effects needed).
// ============================================================

export interface InstanceDialogTarget {
  mode: 'create' | 'edit'
  instance?: InstanceDto
  /** Open with the password field focused (auth-failed handoff). */
  focusPassword?: boolean
}

interface InstanceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: InstanceDialogTarget | null
  /** Refresh registry + overview after a successful save. */
  onSaved: () => void
}

/** Eight preset color tags + "default" (null). */
const COLOR_PRESETS = ['#6D28D9', '#F6511D', '#047857', '#B3212E', '#0F766E', '#BE185D', '#B45309', '#0F1419'] as const

type TestState = 'idle' | 'testing' | 'ok' | 'error'

export function InstanceDialog({ open, onOpenChange, target, onSaved }: InstanceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        {target != null && (
          <InstanceForm key={`${target.mode}:${target.instance?.id ?? 'new'}`} target={target} onOpenChange={onOpenChange} onSaved={onSaved} />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface InstanceFormProps {
  target: InstanceDialogTarget
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

function InstanceForm({ target, onOpenChange, onSaved }: InstanceFormProps) {
  const isEdit = target.mode === 'edit'
  const instance = target.instance
  const { toast } = useToast()

  // ── Form state — seeded fresh per dialog open (see file header) ──
  const [name, setName] = useState(instance?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(instance?.baseUrl ?? '')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [handle, setHandle] = useState(instance?.handle ?? '')
  const [colorTag, setColorTag] = useState<string | null>(instance?.colorTag ?? null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // ── Connectivity test (FR-B2) ──
  const [testState, setTestState] = useState<TestState>('idle')
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const [testPending, setTestPending] = useState<number | null>(null)
  const [testRetryAfter, setTestRetryAfter] = useState<number | null>(null)
  const testCountdown = useCountdownFromSeconds(testRetryAfter ?? 0)

  // ── E10 override ──
  const [saveWithoutTest, setSaveWithoutTest] = useState(false)

  // auth-failed handoff: focus the password field after the dialog's
  // own initial focus pass (the input is addressed by id — SecretInput
  // does not forward refs).
  useEffect(() => {
    if (target.focusPassword !== true) return
    const id = window.setTimeout(() => {
      document.getElementById('instance-password')?.focus()
    }, 50)
    return () => { window.clearTimeout(id) }
  }, [target.focusPassword])

  // Any edit of URL/password invalidates a previous test result —
  // event-driven (not an effect): the reset rides the same handler
  // that changed the input.
  const invalidateTest = useCallback(() => {
    setTestState('idle')
    setTestMessage(null)
    setTestPending(null)
    setTestRetryAfter(null)
  }, [])

  const trimmedBaseUrl = baseUrl.trim()
  // Scheme/validation is the SERVER's call (FR-B1 https rule + SSRF guard
  // answer through the test endpoint verbatim) — the client only gates on
  // the fields being filled.
  const canTest = trimmedBaseUrl.length > 0 && password.length > 0
  const needsPasswordForTest = isEdit && password.length === 0

  const runTest = useCallback(async () => {
    if (!canTest || testState === 'testing') return
    setTestState('testing')
    setTestMessage(null)
    const result = await controllerFetch<ConnectionTestResult>('/api/controller/instances/test', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: trimmedBaseUrl, adminPassword: password }),
    })
    const data = result.ok ? result.data : null
    if (data == null) {
      setTestState('error')
      setTestMessage(result.error)
      setTestPending(null)
      setTestRetryAfter(null)
      return
    }
    setTestState(data.ok ? 'ok' : 'error')
    setTestMessage(data.message)
    setTestPending(data.pending ?? null)
    setTestRetryAfter(data.retryAfterSec ?? null)
  }, [canTest, testState, trimmedBaseUrl, password])

  const save = useCallback(async () => {
    if (saving) return
    const trimmedName = name.trim()
    if (trimmedName.length === 0 || trimmedBaseUrl.length === 0) return
    if (!isEdit && password.length === 0) return
    setSaving(true)
    setFormError(null)

    const normalizedHandle = handle.trim().replace(/^@+/, '')
    const handleValue = normalizedHandle.length > 0 ? normalizedHandle : null

    const finish = (title: string) => {
      setSaving(false)
      toast({ title })
      onSaved()
      onOpenChange(false)
    }

    if (isEdit) {
      const body: InstanceUpdateInput = {
        name: trimmedName,
        handle: handleValue,
        colorTag,
        ...(password.length > 0 ? { adminPassword: password } : {}),
      }
      const result = await controllerFetch<{ instance: InstanceDto }>(
        `/api/controller/instances/${encodeURIComponent(instance?.id ?? '')}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      )
      if (result.ok) {
        finish('Instance diperbarui')
        return
      }
      setSaving(false)
      setFormError(result.error)
      return
    }

    const body: InstanceCreateInput = {
      name: trimmedName,
      baseUrl: trimmedBaseUrl,
      adminPassword: password,
      handle: handleValue,
      colorTag,
    }
    const result = await controllerFetch<{ instance: InstanceDto }>('/api/controller/instances', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (result.ok) {
      finish('Instance ditambahkan')
      return
    }
    setSaving(false)
    setFormError(result.error)
  }, [saving, name, trimmedBaseUrl, isEdit, password, handle, colorTag, instance?.id, toast, onSaved, onOpenChange])

  const saveDisabled =
    saving ||
    name.trim().length === 0 ||
    trimmedBaseUrl.length === 0 ||
    (!isEdit && password.length === 0) ||
    (!isEdit && testState !== 'ok' && !saveWithoutTest)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? 'Edit Instance' : 'Tambah Instance'}</DialogTitle>
        <DialogDescription>
          {isEdit
            ? 'Perbarui detail instance. URL tidak dapat diubah; biarkan password kosong untuk mempertahankan yang tersimpan.'
            : 'Daftarkan deployment Tweetfess untuk dimonitor controller.'}
        </DialogDescription>
      </DialogHeader>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="instance-name" className="text-sm font-medium text-ink">Nama</label>
          <Input
            id="instance-name"
            value={name}
            onChange={(e) => { setName(e.target.value) }}
            placeholder="Nama instance"
            required
            maxLength={60}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="instance-url" className="text-sm font-medium text-ink">URL Instance</label>
          <Input
            id="instance-url"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); invalidateTest() }}
            placeholder="https://menfess.example.com"
            className="font-mono"
            disabled={isEdit}
            required
            autoComplete="off"
          />
          <p className="text-xs text-ink-3">
            {isEdit
              ? 'URL tidak dapat diubah setelah instance didaftarkan.'
              : 'URL deployment Tweetfess, diawali https://'}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="instance-password" className="text-sm font-medium text-ink">Password Admin Instance</label>
          <SecretInput
            id="instance-password"
            value={password}
            onChange={(value) => { setPassword(value); invalidateTest() }}
            placeholder={
              isEdit
                ? '•••••••• (biarkan kosong untuk mempertahankan)'
                : 'Password admin instance...'
            }
            reveal={reveal}
            onRevealChange={setReveal}
            autoComplete="new-password"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="instance-handle" className="text-sm font-medium text-ink">Handle X (opsional)</label>
          <Input
            id="instance-handle"
            value={handle}
            onChange={(e) => { setHandle(e.target.value) }}
            placeholder="tanpa @"
            maxLength={40}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-ink" aria-hidden>Warna</span>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Warna instance">
            <button
              type="button"
              onClick={() => { setColorTag(null) }}
              aria-pressed={colorTag == null}
              aria-label="Warna default"
              className={cn(
                'flex size-8 items-center justify-center rounded-full border border-line bg-cerah-surface-2 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                colorTag == null && 'ring-2 ring-ring ring-offset-2 ring-offset-surface',
              )}
            >
              <span className="text-[0.6rem] font-semibold text-ink-3">std</span>
            </button>
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => { setColorTag(color) }}
                aria-pressed={colorTag === color}
                aria-label={`Warna ${color}`}
                className={cn(
                  'size-8 rounded-full border border-line transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  colorTag === color && 'ring-2 ring-ring ring-offset-2 ring-offset-surface',
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        {/* Connectivity test (FR-B2) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { void runTest() }}
              disabled={!canTest || testState === 'testing'}
              className="h-9"
            >
              {testState === 'testing'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <PlugZap className="size-3.5" />}
              Test Koneksi
            </Button>
            {needsPasswordForTest && (
              <span className="text-xs text-ink-3">isi password untuk test</span>
            )}
          </div>
          {testState === 'ok' && (
            <p className="m-0 flex items-start gap-1.5 rounded-md border border-cerah-green-line bg-cerah-green-soft px-2.5 py-1.5 text-xs font-medium leading-relaxed text-cerah-green">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {testPending != null ? `Terhubung — ${testPending} menunggu review` : 'Terhubung'}
            </p>
          )}
          {testState === 'error' && testMessage != null && (
            <p role="alert" className="m-0 flex items-start gap-1.5 rounded-md border border-cerah-red-line bg-cerah-red-soft px-2.5 py-1.5 text-xs leading-relaxed break-words text-cerah-red">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {testMessage}
                {testCountdown > 0 && (
                  <span className="block font-semibold [font-variant-numeric:tabular-nums]">
                    Coba lagi dalam {formatMmSs(testCountdown)}
                  </span>
                )}
              </span>
            </p>
          )}
        </div>

        {/* E10 override — only meaningful in create mode without a passing test. */}
        {!isEdit && (
          <div className="flex items-start gap-2.5 rounded-md border border-line bg-cerah-surface-2 px-3 py-2.5">
            <Switch
              id="save-without-test"
              checked={saveWithoutTest}
              onCheckedChange={setSaveWithoutTest}
              disabled={testState === 'ok'}
            />
            <label htmlFor="save-without-test" className="cursor-pointer text-xs leading-relaxed text-ink-2">
              Simpan tanpa tes berhasil — instance bisa gagal terhubung sampai password atau URL diperbaiki.
            </label>
          </div>
        )}

        {formError != null && (
          <p role="alert" className="m-0 rounded-md border border-cerah-red-line bg-cerah-red-soft px-2.5 py-1.5 text-xs leading-relaxed text-cerah-red">
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={() => { onOpenChange(false) }} disabled={saving}>
            Batal
          </Button>
          <Button type="submit" disabled={saveDisabled}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {isEdit ? 'Simpan' : 'Tambah Instance'}
          </Button>
        </div>
      </form>
    </>
  )
}
