'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { InstanceDto } from '@/lib/controller/types'
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
import { useToast } from '@/hooks/use-toast'
import { controllerFetch } from '@/hooks/use-controller-session'

// ============================================================
// delete-instance-dialog.tsx — typed-name delete confirm (FR-B4)
//
// Destructive handoff: the confirm button unlocks only on an exact
// name match, the warning states the blast radius (registry row
// only — instance data is never touched), and a server 400 (name
// mismatch) renders inline instead of closing the dialog. The form
// lives inside AlertDialogContent, which Radix unmounts on close —
// every open cycle starts with a clean confirm field.
// ============================================================

interface DeleteInstanceDialogProps {
  instance: InstanceDto | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Refresh registry + overview after a successful delete. */
  onDeleted: () => void
}

export function DeleteInstanceDialog({ instance, open, onOpenChange, onDeleted }: DeleteInstanceDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {instance != null && (
          <DeleteForm key={instance.id} instance={instance} onOpenChange={onOpenChange} onDeleted={onDeleted} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface DeleteFormProps {
  instance: InstanceDto
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}

function DeleteForm({ instance, onOpenChange, onDeleted }: DeleteFormProps) {
  const { toast } = useToast()
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const deleteInstance = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    const result = await controllerFetch<{ success: boolean }>(
      `/api/controller/instances/${encodeURIComponent(instance.id)}`,
      { method: 'DELETE', body: JSON.stringify({ confirmName }) },
    )
    setDeleting(false)
    if (result.ok) {
      toast({ title: 'Instance dihapus' })
      onDeleted()
      onOpenChange(false)
      return
    }
    setError(result.error)
  }

  const nameMatches = confirmName === instance.name

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Hapus instance &quot;{instance.name}&quot;?</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <span>
            Instance di registry controller yang dihapus; data di instance tidak tersentuh.
            Ketik <strong>{instance.name}</strong> untuk konfirmasi.
          </span>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <Input
        value={confirmName}
        onChange={(e) => { setConfirmName(e.target.value); setError(null) }}
        placeholder="Ketik nama instance untuk konfirmasi"
        aria-label="Ketik nama instance untuk konfirmasi"
        autoComplete="off"
        disabled={deleting}
      />
      {error != null && (
        <p role="alert" className="m-0 rounded-md border border-cerah-red-line bg-cerah-red-soft px-2.5 py-1.5 text-xs leading-relaxed text-cerah-red">
          {error}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={deleting}>Batal</AlertDialogCancel>
        <AlertDialogAction
          disabled={!nameMatches || deleting}
          className="bg-cerah-red text-white hover:bg-cerah-red-strong"
          onClick={(e) => {
            // Keep the dialog open while the request runs — the action
            // closes it itself on success.
            e.preventDefault()
            void deleteInstance()
          }}
        >
          {deleting && <Loader2 className="size-3.5 animate-spin" />}
          Hapus Instance
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
