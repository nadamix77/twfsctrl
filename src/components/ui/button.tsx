import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/core/utils"

/* ============================================================
   BUTTON SYSTEM v2 (Cerah) — canonical across all boards:
   pill radius, semantic color variants matching the uiux mockup
   button block verbatim. Sizes: default 44px (the platform target
   guideline); sm 38px — the documented dense-row floor, above WCAG
   2.5.8's 24px minimum. Money-path primary actions are always
   tier-default (44px).
   ============================================================ */

const buttonVariants = cva(
  "inline-flex min-w-6 items-center justify-center gap-2 whitespace-nowrap rounded-full text-[0.95rem] font-semibold leading-[1.2] transition-colors duration-[180ms] disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 active:translate-y-px cursor-pointer select-none",
  {
    variants: {
      variant: {
        /* X / ink — primary posting + login actions */
        ink:
          "bg-ink text-white shadow-xs hover:bg-ink-hover",
        /* Brand purple — save, top-up points */
        accent:
          "bg-brand text-white shadow-xs hover:bg-brand-strong",
        outline:
          "border border-line bg-transparent text-ink hover:bg-cerah-surface-2",
        ghost:
          "text-cerah-ink-2 hover:bg-cerah-surface-2 hover:text-ink",
        destructive:
          "bg-cerah-red text-white shadow-xs hover:bg-cerah-red-strong",
        "destructive-outline":
          "border border-cerah-red-line bg-cerah-red-soft text-cerah-red hover:bg-cerah-red hover:text-white",
        amber:
          "bg-cerah-amber-strong text-white shadow-xs hover:bg-cerah-amber-deep",
        link: "text-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-11 px-5 py-2.5 has-[>svg]:px-4",
        sm: "min-h-[38px] px-4 py-2 text-[0.875rem] gap-1.5 [&_svg:not([class*='size-'])]:size-[15px]",
        lg: "min-h-[52px] px-7 py-3.5 text-[1.05rem] [&_svg:not([class*='size-'])]:size-[18px]",
        icon: "size-11 p-0",
      },
    },
    defaultVariants: {
      variant: "ink",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
