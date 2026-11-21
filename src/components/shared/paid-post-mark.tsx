'use client'

import { Star } from 'lucide-react'
import { cn } from '@/lib/core/utils'

interface PaidPostMarkProps {
  className?: string
}

/** Cerah paid-post mark — the gold star signaling a submission created
 *  through the pay-to-post lane (a submission_spend ledger row exists).
 *  One canonical style shared by the my-posts list and the /admin
 *  submission cards, mirroring StatusBadge. Icon-only: the meaning is
 *  carried by the sr-only text (screen readers) and the native title
 *  (hover). Amber-strong is the amber glyph standard of these rows and
 *  passes WCAG 1.4.11's 3:1 on every list surface — white cards, tinted
 *  parity rows, and hover. The star (not Coins) keeps paid-lane
 *  provenance visually distinct — Coins is reserved for money amounts
 *  (the PointsBadge wallet chip, refund chips, top-up rows). */
export function PaidPostMark({ className }: PaidPostMarkProps) {
  return (
    <span
      className={cn('inline-flex items-center text-cerah-amber-strong', className)}
      title="Kiriman berbayar"
    >
      <Star className="size-3.5" aria-hidden />
      <span className="sr-only">Kiriman berbayar</span>
    </span>
  )
}
