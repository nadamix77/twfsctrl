// ============================================================
// error-boundary-copy.ts — the single source of the boundary copy
//
// The route error boundary must NEVER render error.message (it
// carries server internals: chunk paths, source fragments, raw
// driver errors). Both boundaries (error.tsx + global-error.tsx)
// render these fixed sentences; the digest is exposed sr-only for
// support correlation. Defined once, testable (C3).
// ============================================================

export const ERROR_BOUNDARY_TITLE = 'Terjadi Kesalahan'

export const ERROR_BOUNDARY_MESSAGE =
  'Server sedang mengalami gangguan sebentar. Coba lagi, atau kembali beberapa saat lagi.'

/** The sr-only support line shown when Next attaches a request digest. */
export function reportCodeLabel(digest: string): string {
  return `Kode laporan: ${digest}`
}
