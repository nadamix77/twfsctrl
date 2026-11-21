'use client'

import { useState } from 'react'
import { Loader2, Pencil } from 'lucide-react'
import type { QueueActionResponse, QueueItem } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

// ============================================================
// edit-message-dialog.tsx — "Edit Pesan" (the instance app's
// message-only content edit, PUT /api/submissions/:id)
//
// The composer's own floor applies client-side (min 5 chars after
// trim — the instance re-validates with the same copy); a no-op save
// (unchanged message) is disabled at the button, mirroring the
// instance's zero-effect no-write guard.
//
// The form is a child of DialogContent: Radix unmounts the content
// when the dialog closes, so every open cycle starts from a fresh
// useState seed (the instance-dialog doctrine — no reset effects).
// ============================================================

const MIN_MESSAGE_LENGTH = 5
const MAX_MESSAGE_LENGTH = 5_000

interface EditMessageDialogProps {
  item: QueueItem
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs the `edit` action; returns the instance envelope (null on
   *  transport failure — the row already cascaded). */
  onSubmit: (message: string) => Promise<QueueActionResponse | null>
}

function EditMessageForm({
  item,
  close,
  onSubmit,
}: {
  item: QueueItem
  close: () => void
  onSubmit: EditMessageDialogProps['onSubmit']
}) {
  const [value, setValue] = useState(item.message)
  const [submitting, setSubmitting] = useState(false)

  const trimmed = value.trim()
  const tooShort = trimmed.length < MIN_MESSAGE_LENGTH
  const tooLong = value.length > MAX_MESSAGE_LENGTH
  const unchanged = trimmed === item.message.trim()
  const invalid = tooShort || tooLong || unchanged || submitting

  const handleSubmit = async () => {
    if (invalid) return
    setSubmitting(true)
    const envelope = await onSubmit(trimmed)
    setSubmitting(false)
    if (envelope == null || envelope.ok) close()
  }

  return (
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.5 text-base">
          <Pencil className="size-4 text-ink-2" aria-hidden />
          Edit Pesan
        </DialogTitle>
        <DialogDescription>
          Pesan dari @{item.submitter.username} di {item.instanceName}. Perubahan berlaku sebelum pesan diposting ke X.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Textarea
          value={value}
          onChange={(e) => { setValue(e.target.value) }}
          aria-label="Pesan"
          rows={6}
          className="min-h-28 resize-y text-sm leading-relaxed"
          disabled={submitting}
        />
        <div className="flex items-center justify-between text-xs text-ink-3">
          <span aria-live="polite">
            {tooShort
              ? `Minimal ${MIN_MESSAGE_LENGTH} karakter`
              : unchanged
                ? 'Pesan belum diubah'
                : '\u00A0'}
          </span>
          <span className="[font-variant-numeric:tabular-nums]">
            {value.length}/{MAX_MESSAGE_LENGTH}
          </span>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={close} disabled={submitting}>
          Batal
        </Button>
        <Button onClick={() => { void handleSubmit() }} disabled={invalid}>
          {submitting && <Loader2 className="size-3.5 animate-spin" />}
          Simpan
        </Button>
      </div>
    </DialogContent>
  )
}

export function EditMessageDialog({ item, open, onOpenChange, onSubmit }: EditMessageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <EditMessageForm item={item} close={() => { onOpenChange(false) }} onSubmit={onSubmit} />}
    </Dialog>
  )
}
