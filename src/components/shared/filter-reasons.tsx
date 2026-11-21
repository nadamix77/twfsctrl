'use client'

import { ShieldAlert } from 'lucide-react'
import { getFilterReasonLabel, parseFilterReasons, formatNsfwCategories } from '@/lib/core/format'

interface FilterReasonsProps {
  filterReasons: string | null
  nsfwCategories?: string | null  // JSON: {"Porn":0.87,"Hentai":0.10,"Sexy":0.03}
}

/** A chip is a label container. Past this length the label is a
 *  sentence (the AI verdicts are free-text explanations), and a
 *  sentence in a stadium-shaped badge wraps with its end-caps eating
 *  the first and last lines' edges — disproportionate on mobile. Long
 *  reasons render as a note block instead: own line, panel radius,
 *  sentence typography. */
const CHIP_LABEL_MAX = 40

/** How many short chips render before the rest collapse into "+N more".
 *  The cap applies to SHORT labels only — long reasons (the AI verdict
 *  sentences) always render in full. The submissions route appends AI
 *  reasons after every non-AI flag ([...nonAiReasons, ...aiReasons]),
 *  so a capped row would bury the AI verdict behind the count chip:
 *  the one sentence that explains WHY AI flagged the post would be the
 *  one thing hidden. Notes never count toward the cap. */
const CHIP_ROW_MAX = 3

/* ============================================================
   FilterReasons — Cerah censor chips (light-5 §"flag-row"):
   amber flag count badge + red reason chips; long reasons
   (AI verdict sentences) drop to a full-line note block and
   always render — "+N more" caps only the short chips.
   ============================================================ */
export function FilterReasons({ filterReasons, nsfwCategories }: FilterReasonsProps) {
  const reasons = parseFilterReasons(filterReasons)
  if (reasons.length === 0) return null

  // Rich NSFW category label when per-category data exists, default otherwise.
  const hasNsfwFlagged = reasons.some(r => r.startsWith('nsfw_flagged') || r === 'nsfw_flagged')
  const nsfwCategoryLabel = (hasNsfwFlagged && nsfwCategories) ? formatNsfwCategories(nsfwCategories) : null

  const labelOf = (reason: string) =>
    nsfwCategoryLabel && (reason.startsWith('nsfw_flagged') || reason === 'nsfw_flagged')
      ? nsfwCategoryLabel
      : getFilterReasonLabel(reason)

  // Long labels (notes) always render; only short labels compete for the
  // capped chip slots, and only hidden SHORT labels sum into "+N more".
  // Index-keyed (not string-keyed) so duplicate reason strings, if any,
  // each get their own slot decision.
  const isNote = (reason: string) => labelOf(reason).length > CHIP_LABEL_MAX
  const shortCount = reasons.filter(r => !isNote(r)).length
  const hiddenShortCount = Math.max(0, shortCount - CHIP_ROW_MAX)
  const visibleShortIndexes = new Set(
    reasons
      .map((reason, index) => ({ reason, index }))
      .filter(({ reason }) => !isNote(reason))
      .slice(0, CHIP_ROW_MAX)
      .map(({ index }) => index),
  )

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {/* Censor flags — unconditional: an empty reasons array returned null at the top */}
      <span className="inline-flex items-center gap-1.5 rounded-full border border-cerah-amber-line bg-surface px-2 py-0.5 text-[10px] font-bold leading-[1.4] text-cerah-amber-strong">
        <ShieldAlert className="size-3" />
        {reasons.length} filter flag{reasons.length > 1 ? 's' : ''}
      </span>
      {reasons.map((reason, index) => {
        const label = labelOf(reason)
        if (isNote(reason)) {
          return (
            <span
              key={`censor-${index}`}
              className="basis-full min-w-0 rounded-md border border-cerah-red-line bg-cerah-red-soft px-2.5 py-1.5 text-[10px] font-normal leading-relaxed break-words text-cerah-red"
            >
              {label}
            </span>
          )
        }
        if (!visibleShortIndexes.has(index)) return null
        return (
          <span
            key={`censor-${index}`}
            className="rounded-full border border-cerah-red-line bg-cerah-red-soft px-2 py-0.5 text-[10px] font-semibold leading-[1.4] text-cerah-red"
          >
            {label}
          </span>
        )
      })}
      {hiddenShortCount > 0 && (
        <span className="rounded-full border border-line bg-cerah-surface-2 px-2 py-0.5 text-[10px] font-medium leading-[1.4] text-ink-2">
          +{hiddenShortCount} lagi
        </span>
      )}
    </div>
  )
}
