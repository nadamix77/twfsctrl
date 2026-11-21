'use client'

import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { EyeOff, Loader2, Plus, RotateCcw, X } from 'lucide-react'
import type { CensorRegionInput, QueueActionResponse, QueueItem } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/core/utils'

// ============================================================
// censor-image-dialog.tsx — "Sensor Gambar" (the instance app's
// region image censor, POST /api/submissions/:id/censor)
//
// Ported from the instance's censor-image-dialog: drag on the image
// to draw a rect (default type 'black'), then per region pick the
// censor type (pixelate / blur / black), rotate it (angle around its
// own center — the same center the server rotates around), or delete
// it. Regions live in FRACTIONAL image coordinates (x/y/w/h in 0..1)
// so the geometry is resolution-independent. The renderer runs
// server-side on the instance; the overlay here is only a live,
// deliberately approximate preview (the instance app discloses the
// same). Keyboard users add a default centered region via the
// "Tambah area" button, then adjust type/angle/delete from the list.
//
// The editor is a child of DialogContent: Radix unmounts the content
// when the dialog closes, so every open cycle starts from fresh
// useState seeds (the instance-dialog doctrine — no reset effects).
// ============================================================

const MAX_CENSOR_REGIONS = 16
/** Drag rects below this fractional area are discarded (accidental taps). */
const MIN_REGION_AREA = 0.0015

/** Region with a local React key — the key never leaves the client. */
interface DrawableRegion extends CensorRegionInput {
  key: number
}

const TYPE_OPTIONS = [
  { value: 'pixelate', label: 'Pikselasi' },
  { value: 'blur', label: 'Kabur' },
  { value: 'black', label: 'Hitam pekat' },
] as const

/** Live preview style per type — approximate, disclosed as such.
 *  pixelate: coarse hatch; blur: backdrop blur; black: solid. */
function regionPreviewClass(type: CensorRegionInput['type']): string {
  if (type === 'black') return 'bg-ink'
  if (type === 'blur') return 'bg-white/10 backdrop-blur-md'
  return 'bg-[repeating-linear-gradient(90deg,rgba(15,23,42,0.85)_0_6px,rgba(15,23,42,0.55)_6px_12px)]'
}

interface CensorImageDialogProps {
  item: QueueItem
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs the `censor` action; returns the instance envelope (null on
   *  transport failure — the row already cascaded). */
  onSubmit: (regions: CensorRegionInput[]) => Promise<QueueActionResponse | null>
}

function CensorImageEditor({
  item,
  close,
  onSubmit,
}: {
  item: QueueItem
  close: () => void
  onSubmit: CensorImageDialogProps['onSubmit']
}) {
  const [regions, setRegions] = useState<DrawableRegion[]>([])
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [imgFailed, setImgFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const nextKeyRef = useRef(1)

  // ── Drawing (pointer, mouse + touch) ────────────────────

  const toFraction = useCallback((clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (rect == null || rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    }
  }, [])

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (submitting || imgFailed) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (regions.length >= MAX_CENSOR_REGIONS) return
    const start = toFraction(e.clientX, e.clientY)
    if (start == null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    setDrawing({ x0: start.x, y0: start.y, x1: start.x, y1: start.y })
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing == null) return
    const point = toFraction(e.clientX, e.clientY)
    if (point == null) return
    setDrawing((prev) => (prev == null ? prev : { ...prev, x1: point.x, y1: point.y }))
  }

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing == null) return
    const point = toFraction(e.clientX, e.clientY)
    const end = point ?? { x: drawing.x1, y: drawing.y1 }
    const rect = {
      x: Math.min(drawing.x0, end.x),
      y: Math.min(drawing.y0, end.y),
      w: Math.abs(end.x - drawing.x0),
      h: Math.abs(end.y - drawing.y0),
    }
    setDrawing(null)
    if (rect.w * rect.h < MIN_REGION_AREA) return // accidental tap — discard
    setRegions((prev) =>
      prev.length >= MAX_CENSOR_REGIONS
        ? prev
        : [...prev, { ...rect, type: 'black', key: nextKeyRef.current++ }],
    )
  }

  /** Keyboard fallback: a default centered region, adjustable via the list. */
  const addDefaultRegion = () => {
    setRegions((prev) =>
      prev.length >= MAX_CENSOR_REGIONS
        ? prev
        : [...prev, { x: 0.3, y: 0.4, w: 0.4, h: 0.2, type: 'black', key: nextKeyRef.current++ }],
    )
  }

  // ── Region list editing ─────────────────────────────────

  const setRegionType = (key: number, type: CensorRegionInput['type']) => {
    setRegions((prev) => prev.map((r) => (r.key === key ? { ...r, type } : r)))
  }

  const setRegionAngle = (key: number, angle: number) => {
    setRegions((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r
        // Canonical form: absent = axis-aligned; explicit 0 collapses to absent.
        const { angle: _old, ...rest } = r
        return angle === 0 ? rest : { ...rest, angle }
      }),
    )
  }

  const removeRegion = (key: number) => {
    setRegions((prev) => prev.filter((r) => r.key !== key))
  }

  // ── Submit ──────────────────────────────────────────────

  const handleSubmit = async () => {
    if (regions.length === 0 || submitting) return
    setSubmitting(true)
    const payload: CensorRegionInput[] = regions.map(({ key: _key, ...region }) => region)
    const envelope = await onSubmit(payload)
    setSubmitting(false)
    if (envelope == null || envelope.ok) close()
  }

  // The in-flight drag rect, normalized for rendering.
  const draft =
    drawing != null
      ? {
          x: Math.min(drawing.x0, drawing.x1),
          y: Math.min(drawing.y0, drawing.y1),
          w: Math.abs(drawing.x1 - drawing.x0),
          h: Math.abs(drawing.y1 - drawing.y0),
        }
      : null

  const canDraw = !imgFailed && regions.length < MAX_CENSOR_REGIONS && !submitting

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <EyeOff className="size-4 text-ink-2" aria-hidden />
            Sensor Gambar
          </DialogTitle>
          <DialogDescription>
            Gambar kiriman dari @{item.submitter.username} di {item.instanceName}. Seret di gambar untuk membuat area
            sensor — area diproses permanen di server instance.
          </DialogDescription>
        </DialogHeader>

        {/* Draw surface — the image with the region overlays. */}
        {imgFailed ? (
          <p className="m-0 rounded-lg border border-cerah-amber-line bg-cerah-amber-soft px-3 py-6 text-center text-xs text-cerah-amber-strong">
            Gambar tidak dapat dimuat dari instance. Muat ulang antrean lalu coba lagi.
          </p>
        ) : (
          <div className="flex justify-center">
            <div
              ref={surfaceRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { setDrawing(null) }}
              className={cn(
                'relative inline-flex touch-none select-none overflow-hidden rounded-lg border border-line',
                canDraw ? 'cursor-crosshair' : 'cursor-not-allowed',
              )}
              aria-label="Area gambar untuk sensor"
            >
              {/* Plain <img> — the controller proxy URL is same-origin (E11). */}
              <img
                src={item.imageUrl ?? ''}
                alt="Gambar kiriman"
                draggable={false}
                onError={() => { setImgFailed(true) }}
                className="block max-h-[52vh] w-auto"
              />

              {/* Committed regions */}
              {regions.map((region) => (
                <span
                  key={region.key}
                  aria-hidden
                  className={cn('absolute border border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]', regionPreviewClass(region.type))}
                  style={
                    {
                      left: `${region.x * 100}%`,
                      top: `${region.y * 100}%`,
                      width: `${region.w * 100}%`,
                      height: `${region.h * 100}%`,
                      transform: region.angle != null ? `rotate(${region.angle}deg)` : undefined,
                    } satisfies CSSProperties
                  }
                />
              ))}

              {/* In-flight draft */}
              {draft != null && draft.w > 0 && draft.h > 0 && (
                <span
                  aria-hidden
                  className="absolute border-2 border-dashed border-white bg-white/10"
                  style={{
                    left: `${draft.x * 100}%`,
                    top: `${draft.y * 100}%`,
                    width: `${draft.w * 100}%`,
                    height: `${draft.h * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* Region list — per-region type / angle / delete. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-xs text-ink-3">
              {regions.length}/{MAX_CENSOR_REGIONS} area
              {regions.length === 0 && !imgFailed ? ' — seret di gambar untuk mulai' : ''}
            </p>
            <div className="flex items-center gap-1.5">
              {regions.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setRegions([]) }}
                  disabled={submitting}
                  className="h-8 px-2.5 text-xs text-ink-2 hover:text-ink"
                >
                  <RotateCcw className="size-3.5" />
                  Atur ulang
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addDefaultRegion}
                disabled={!canDraw}
                className="h-8 px-2.5 text-xs"
              >
                <Plus className="size-3.5" />
                Tambah area
              </Button>
            </div>
          </div>

          {regions.length > 0 && (
            <ul className="m-0 flex max-h-40 list-none flex-col gap-1.5 overflow-y-auto p-0" aria-label="Daftar area sensor">
              {regions.map((region, index) => (
                <li
                  key={region.key}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-cerah-surface-2/60 px-2.5 py-1.5"
                >
                  <span className="min-w-12 text-xs font-semibold text-ink">Area {index + 1}</span>
                  <Select
                    value={region.type}
                    onValueChange={(value) => { setRegionType(region.key, value as CensorRegionInput['type']) }}
                    disabled={submitting}
                  >
                    <SelectTrigger aria-label={`Jenis sensor area ${index + 1}`} className="h-8 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="text-xs">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="flex min-w-40 flex-1 items-center gap-2 text-xs text-ink-3">
                    <span aria-hidden className="shrink-0">
                      Rotasi
                    </span>
                    <Slider
                      value={[region.angle ?? 0]}
                      onValueChange={(values) => { setRegionAngle(region.key, values[0] ?? 0) }}
                      min={-180}
                      max={180}
                      step={15}
                      disabled={submitting}
                      aria-label={`Sudut rotasi area ${index + 1}`}
                      className="flex-1"
                    />
                    <span className="w-10 shrink-0 text-right [font-variant-numeric:tabular-nums]">
                      {region.angle ?? 0}°
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { removeRegion(region.key) }}
                    disabled={submitting}
                    aria-label={`Hapus area ${index + 1}`}
                    className="size-8 shrink-0 p-0 text-ink-3 hover:text-cerah-red"
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={close} disabled={submitting}>
            Batal
          </Button>
          <Button onClick={() => { void handleSubmit() }} disabled={regions.length === 0 || submitting}>
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            Sensor {regions.length > 0 ? `(${regions.length})` : ''}
          </Button>
        </div>
    </DialogContent>
  )
}

export function CensorImageDialog({ item, open, onOpenChange, onSubmit }: CensorImageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <CensorImageEditor item={item} close={() => { onOpenChange(false) }} onSubmit={onSubmit} />}
    </Dialog>
  )
}
