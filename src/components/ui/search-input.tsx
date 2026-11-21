import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Accessible name — placeholder-only inputs lose their name after
   *  the first keystroke (REQ-07). */
  'aria-label'?: string
  className?: string
  inputClassName?: string
}

export function SearchInput({ value, onChange, placeholder, 'aria-label': ariaLabel, className, inputClassName }: SearchInputProps) {
  return (
    <div className={`relative ${className ?? ''}`}>
      <Input
        placeholder={placeholder ?? 'Cari...'}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => { onChange(e.target.value) }}
        className={`border-line ${inputClassName ?? 'pl-8'}`}
      />
      <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
      {value && (
        // In-field clear X — the secret-input eye idiom: default-size floor
        // (min-h-11) with a size-9 p-0 box (36w × 44h) and a transparent
        // x-halo widening the hit area to 44×44 inside the field.
        <Button
          type="button"
          variant="ghost"
          aria-label="Hapus pencarian"
          className="absolute right-1 top-1/2 -translate-y-1/2 size-9 p-0 text-ink-3 hover:text-ink after:absolute after:inset-y-0 after:inset-x-[-4px] after:content-['']"
          onClick={() => { onChange('') }}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
