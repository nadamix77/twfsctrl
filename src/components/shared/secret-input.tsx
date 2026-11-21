'use client'

import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface SecretInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  reveal: boolean
  onRevealChange: (reveal: boolean) => void
  /** Forwarded to the <input> so credential call sites can set
   *  autoComplete="off" (browser autofill must never fill secrets). */
  autoComplete?: string
  className?: string
  inputClassName?: string
  /** Override the eye toggle button classes. Default: "absolute right-1 top-1/2 -translate-y-1/2 size-9 p-0"
   *  (36px visual inside the 44px input; a transparent after:-halo widens the
   *  hit area to 44px wide × 36px tall — inset-y-0 clips it to the field
   *  height, the ToastClose idiom, comfortably above WCAG 2.5.8's 24px
   *  target minimum). */
  buttonClassName?: string
  /** Override the eye icon classes. Default: "w-4 h-4" */
  iconClassName?: string
}

export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  reveal,
  onRevealChange,
  autoComplete,
  className,
  inputClassName,
  buttonClassName,
  iconClassName,
}: SecretInputProps) {
  // If inputClassName already contains a pr-* class, use it directly
  // to avoid fragile conflicting padding classes (e.g. pr-8 + pr-10).
  // Otherwise, default to pr-8 to keep text from overlapping the eye button.
  // Secrets render mono (light-7 `.inp.mono`).
  const hasPaddingRight = inputClassName != null && /\bpr-\S+/.test(inputClassName)
  const resolvedInputClassName = hasPaddingRight
    ? `font-mono ${inputClassName}`
    : `pr-8 font-mono${inputClassName ? ` ${inputClassName}` : ''}`

  return (
    <div className={`relative ${className ?? ''}`}>
      <Input
        id={id}
        type={reveal ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value) }}
        className={resolvedInputClassName}
        autoComplete={autoComplete}
      />
      {/* type="button": the eye only toggles reveal — inside the form-wrapped
          credential rows (GoBiz) an untyped button would default to submit
          and fire the row's save on every reveal click. */}
      <Button
        type="button"
        variant="ghost"
        className={buttonClassName ?? 'absolute right-1 top-1/2 -translate-y-1/2 size-9 p-0 text-ink-3 hover:text-ink after:absolute after:inset-y-0 after:inset-x-[-4px] after:content-[""]'}
        onClick={() => { onRevealChange(!reveal) }}
        aria-label={reveal ? 'Sembunyikan' : 'Tampilkan'}
      >
        {reveal
          ? <EyeOff className={iconClassName ?? 'w-4 h-4'} />
          : <Eye className={iconClassName ?? 'w-4 h-4'} />}
      </Button>
    </div>
  )
}
