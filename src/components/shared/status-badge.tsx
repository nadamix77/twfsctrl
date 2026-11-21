'use client'

import type { SubmissionStatus } from '@/types'
import { STATUS_CONFIG } from '@/lib/core/format'
import { safeAccess, cn } from '@/lib/core/utils'

interface StatusBadgeProps {
  status: SubmissionStatus
  className?: string
}

/** Cerah status pill — one canonical style shared by the public my-posts
 *  list and the /admin submission cards (consistent across surfaces). */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = safeAccess(STATUS_CONFIG, status)

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-[1.4]',
        config.color,
        className,
      )}
    >
      {config.label}
    </span>
  )
}
