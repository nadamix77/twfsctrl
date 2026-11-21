// ============================================================
// format-idr.ts — IDR currency formatter for the payments UI
// ============================================================
// The repo's formatting inventory is split by layer: format.ts owns the
// platform-agnostic formatters (formatDate, formatRelativeTime,
// formatDayShort, formatMmSs, formatCount — the count sibling of this
// money formatter — plus the filter-reason label maps). The IDR
// formatters live HERE, co-located with the payments UI modules that
// consume them (PRD §13.1): "Rp 10.000" — id-ID locale, no decimals.
// ============================================================

/** Format an IDR amount: 10437 → "Rp 10.437" (id-ID grouping, no decimals). */
export function formatIdr(amountIdr: number): string {
  return `Rp ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(amountIdr)}`
}

/** Compact IDR for space-constrained surfaces (dashboard tiles):
 *  15000 → "Rp 15 rb", 1234567 → "Rp 1 jt" (id-ID compact notation,
 *  maximumFractionDigits 0 — band edges round half-up: 1499 → "Rp 1 rb",
 *  999500 → "Rp 1 jt"). Because the compact form ROUNDS, callers showing
 *  money must carry the exact figure elsewhere (the tiles put the exact
 *  formatIdr value in the aria-label; the Monetisasi footer shows it). */
export function formatIdrCompact(amountIdr: number): string {
  return `Rp ${new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 0 }).format(amountIdr)}`
}

/** Compact IDR for AXIS TICKS (the Statistik Pendapatan y-axis). Unlike
 *  formatIdrCompact, never rounds a tick away from its own gridline: an
 *  axis label marks a POSITION, so 1500000 must read "Rp 1,5 jt" (the
 *  1-2-5 ladder's half-steps), not formatIdrCompact's "Rp 2 jt" sitting
 *  on the 1,5 jt line. One decimal suffices for every k×{1,2,5}×10ⁿ
 *  step; whole rungs render identically to formatIdrCompact. The exact
 *  data figures still live in the card footer + aria (the house
 *  compact-rounds rule). */
export function formatIdrTick(amountIdr: number): string {
  return `Rp ${new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(amountIdr)}`
}
