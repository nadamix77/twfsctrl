import * as React from "react"

import { cn } from "@/lib/core/utils"

/* ============================================================
   TEXTAREA (Cerah) — 12px radius, ink-3 placeholder, purple
   border + crisp 2px accent focus outline (composer recipe).
   ============================================================ */

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-line placeholder:text-ink-3 aria-invalid:border-cerah-red-line flex field-sizing-content min-h-16 w-full rounded-lg border bg-transparent px-3.5 py-2.5 text-[1rem] leading-[1.6] text-ink transition-colors focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
