import * as React from "react"

import { cn } from "@/lib/core/utils"

/* ============================================================
   INPUT (Cerah, light-7 .inp) — 44px min-height, 12px radius,
   line-soft border, surface bg, ink-3 placeholder, crisp 2px
   accent focus outline (no soft ring).
   ============================================================ */

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-line-soft placeholder:text-ink-3 aria-invalid:border-cerah-red-line flex min-h-11 w-full min-w-0 rounded-lg border bg-surface px-3.5 py-2 text-[1rem] text-ink transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "file:inline-flex file:h-10 file:cursor-pointer file:border-0 file:bg-transparent file:px-0 file:py-2 file:text-[1rem] file:font-semibold file:text-ink",
        className
      )}
      {...props}
    />
  )
}

export { Input }
