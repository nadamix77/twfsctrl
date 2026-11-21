import * as React from "react"

import { cn } from "@/lib/core/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "bg-card text-card-foreground flex flex-col gap-6 rounded-2xl border border-line py-6 [box-shadow:var(--shadow)]",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

// CardTitle is a <span> (not a div): its only consumer (settings-card) puts it
// inside a native <button>, where block-level children are invalid content
// model. The consumer always sets display classes (flex), so rendering is
// identical to the old div.
function CardTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}
export { Card, CardHeader, CardTitle, CardContent }
