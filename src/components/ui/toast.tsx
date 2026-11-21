"use client"

import * as React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva, type VariantProps } from "class-variance-authority"
import { CircleAlert, CircleCheck, X } from "lucide-react"

import { cn } from "@/lib/core/utils"

/* ============================================================
   TOAST SYSTEM (Cerah) — recipe from uiux boards light-3/4:
   surface card, 12px radius, --shadow-lg, 32px tinted icon
   tile, 4px progress drain bar synced to the auto-close
   duration. Destructive = soft red tint + red title (never
   a solid red block). Two visual variants only.
   ============================================================ */

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      "fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:pt-4 md:max-w-[420px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border p-3.5 pb-[18px] [box-shadow:var(--shadow-lg)] transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
  {
    variants: {
      variant: {
        default: "border-line bg-surface text-foreground",
        destructive:
          "destructive group border-cerah-red-line bg-cerah-red-soft text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, duration, children, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...(duration !== undefined && { duration })}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-[10px] border",
          variant === "destructive"
            ? "border-cerah-red-line bg-surface text-cerah-red"
            : "border-cerah-green-line bg-cerah-green-soft text-cerah-green"
        )}
      >
        {variant === "destructive" ? (
          <CircleAlert className="size-4" />
        ) : (
          <CircleCheck className="size-4" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <ToastClose />
      <span
        aria-hidden="true"
        className={cn(
          "absolute bottom-0 left-0 h-1 w-full animate-[toast-drain_5s_linear_forwards]",
          variant === "destructive"
            ? "bg-cerah-red-strong"
            : "bg-cerah-green-strong"
        )}
        style={{ animationDuration: `${duration ?? 5000}ms` }}
      />
    </ToastPrimitives.Root>
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "mt-1.5 inline-flex min-h-9 w-fit shrink-0 items-center justify-center rounded-full border border-line bg-transparent px-3 text-[0.8rem] font-semibold text-ink-2 transition-colors hover:bg-cerah-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-50",
      "relative after:absolute after:inset-[-4px] after:content-['']",
      className
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-cerah-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
      "after:absolute after:inset-[-8px] after:content-['']",
      "group-[.destructive]:hover:bg-cerah-red/10 group-[.destructive]:hover:text-cerah-red",
      className
    )}
    toast-close=""
    {...props}
  >
    <X className="size-3.5" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    className={cn(
      "text-[0.85rem] font-semibold text-ink group-[.destructive]:text-cerah-red",
      className
    )}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn(
      "mt-0.5 text-[0.8rem] leading-[1.5] text-ink-2",
      className
    )}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
}
