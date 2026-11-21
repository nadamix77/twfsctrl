'use client'

import { ERROR_BOUNDARY_MESSAGE, ERROR_BOUNDARY_TITLE, reportCodeLabel } from '@/lib/core/error-boundary-copy'
import { Button } from '@/components/ui/button'

// Root-layout errors replace the whole document — the Next contract
// requires global-error.tsx to render its own <html>/<body>.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="id">
      <body className="min-h-screen flex flex-col items-center justify-center bg-cerah-bg px-4 antialiased">
        <main className="flex flex-col items-center justify-center">
          <h1 className="text-2xl font-bold text-ink mb-2">{ERROR_BOUNDARY_TITLE}</h1>
          <p className="text-ink-2 mb-6 text-sm">{ERROR_BOUNDARY_MESSAGE}</p>
          {error.digest ? <p className="sr-only">{reportCodeLabel(error.digest)}</p> : null}
          <Button type="button" variant="ink" onClick={reset}>
            Coba Lagi
          </Button>
        </main>
      </body>
    </html>
  )
}
