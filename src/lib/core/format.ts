// ============================================================
// format.ts — UI formatting helpers
//
// Extracted from src/types/index.ts to keep types pure.
// Imports PostMethodResult from @/types (shared types layer)
// rather than x-api/posting-service-types to maintain
// core→types layering (core must not import from x-api).
// ============================================================

import type { PostMethodResult } from '@/types'

// --- Post Method Descriptions ---

/** Map postMethod → default description when API doesn't provide one.
 *  Uses `satisfies` for compile-time exhaustiveness without lying about
 *  runtime return type — unknown/corrupted postMethod values get the
 *  hardcoded fallback in the access chain, not a runtime crash. */
export const POST_METHOD_DESCRIPTIONS = {
  direct: 'Pesan otomatis diposting ke X.',
  retry: 'Pesan diposting setelah retry.',
  fallback_cookie: 'Pesan diposting via Cookie API (twitterapi.io).',
  fallback_login: 'Pesan diposting via V2 Login API (twitterapi.io).',
} satisfies Record<PostMethodResult, string>

// --- Status Config (for UI rendering) ---
// Cerah status pills (uiux boards light-5/6): always icon/dot + label,
// never color alone.

export const STATUS_CONFIG = {
  pending: { label: 'Menunggu', color: 'bg-cerah-amber-soft border-cerah-amber-line text-cerah-amber-strong' },
  censored: { label: 'Disensor', color: 'bg-cerah-orange-soft border-cerah-orange-line text-cerah-orange' },
  posting: { label: 'Posting', color: 'bg-xblue-soft border-xblue-line text-xblue-ink' },
  post_failed: { label: 'Gagal', color: 'bg-cerah-red-soft border-cerah-red-line text-cerah-red' },
  rejected: { label: 'Ditolak', color: 'bg-cerah-surface-2 border-line text-ink-2' },
  posted: { label: 'Diposting', color: 'bg-cerah-green-soft border-cerah-green-line text-cerah-green' },
} as const

/** Derived status list — single source of truth, mirrors STATUS_CONFIG keys.
 *  Use this instead of hardcoding status arrays to prevent drift when new statuses are added. */
export const SUBMISSION_STATUSES = Object.keys(STATUS_CONFIG) as (keyof typeof STATUS_CONFIG)[]

/** Maps DB status values (snake_case) to Stats object keys (camelCase).
 *  Single source of truth — use this instead of inline ternaries or separate Maps
 *  to prevent drift when statuses are added or renamed. The precise value
 *  union lets consumers index a Stats payload without a cast (the
 *  submission-filters/stats-grid reads). */
export const STATUS_TO_STATS_KEY = {
  pending: 'pending',
  censored: 'censored',
  posting: 'posting',
  post_failed: 'postFailed',
  rejected: 'rejected',
  posted: 'posted',
} as const satisfies Readonly<Record<string, string>>

// --- NSFW Category Abbreviations ---

/** Single-letter abbreviations for NSFW category names, keyed in canonical
 *  display order (Map iteration preserves insertion order).
 *  Used in badge display: NSFW: P(0.87) H(0.10) S(0.03) */
const NSFW_ABBREVIATIONS = new Map([
  ['Porn', 'P'],
  ['Hentai', 'H'],
  ['Sexy', 'S'],
  ['Drawing', 'D'],
  ['Neutral', 'N'],
])

/** Format nsfwCategories JSON into compact badge text.
 *  Shows only categories present in the JSON, in canonical order.
 *  Example: {"Porn":0.87,"Hentai":0.10,"Sexy":0.03} → "NSFW: P(0.87) H(0.10) S(0.03)"
 *  Returns null if categories is null/empty/invalid (fallback to default label). */
export function formatNsfwCategories(nsfwCategories: string | null): string | null {
  if (!nsfwCategories) return null
  try {
    const parsed: Record<string, unknown> = JSON.parse(nsfwCategories)
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const parsedMap = new Map(Object.entries(parsed))
    const parts: string[] = []
    for (const [cat, abbr] of NSFW_ABBREVIATIONS) {
      const value = parsedMap.get(cat)
      if (typeof value === 'number') {
        parts.push(`${abbr}(${value.toFixed(2)})`)
      }
    }
    return parts.length > 0 ? `NSFW: ${parts.join(' ')}` : null
  } catch {
    return null
  }
}

// --- Filter Reason Label Helper ---

/** Prefix-match entries: each has a prefix and a label function that receives the suffix.
 *
 *  The seven sensitive classes carry admin-only detail after the colon
 *  (`blocked_word:<word>` … `solicitation_payment:<word>`). The REAL
 *  boundary is server-side: submissionService.sanitizeFilterReasons strips
 *  the payload from every user-facing response (bare codes reach user chips
 *  and resolve through the exact-match map), so these prefixed forms only
 *  ever render on admin surfaces — where the exact word is the actionable
 *  detail a moderator needs. It is rendered verbatim, never masked: a
 *  masked word on the review screen is ambiguous ("o**n" could be several
 *  words), and the free-text `ai:`/`ai_image:` verdicts already render
 *  verbatim on every surface — masking here was decoration that only
 *  degraded admin review. */
const FILTER_REASON_PREFIX_LABELS: ReadonlyArray<{ prefix: string; label: (suffix: string) => string }> = [
  { prefix: 'blocked_word:', label: w => `Diblokir: "${w}"` },
  { prefix: 'nsfw_word:', label: w => `NSFW: "${w}"` },
  { prefix: 'self_harm:', label: w => `Bahaya diri: "${w}"` },
  { prefix: 'csam_sexual:', label: w => `CSAM (sexual): "${w}"` },
  { prefix: 'csam_age:', label: w => `CSAM (age): "${w}"` },
  { prefix: 'solicitation_sexual:', label: w => `Solicitation (sexual): "${w}"` },
  { prefix: 'solicitation_payment:', label: w => `Solicitation (payment): "${w}"` },
  // Image-text rule hits (FR-6/6b): the suffix is a full rule-engine reason,
  // so it recurses into the label resolver — every inner reason renders with
  // its own established label. Must precede 'ai_image:'.
  { prefix: 'ai_image:image_text:', label: s => `Teks di gambar: ${getFilterReasonLabel(s)}` },
  { prefix: 'ai_image:', label: s => `Vision AI: ${s}` },
  { prefix: 'ai:', label: s => `AI: ${s}` },
  { prefix: 'jualan:', label: t => `Marketplace (${t})` },
  { prefix: 'nsfw_flagged:', label: s => `NSFW Image (${s})` },
  { prefix: 'nsfw_rejected:', label: s => `NSFW Rejected (${s})` },
  // NSFW pipeline infra markers (L-52): the suffix after the colon is the
  // internal phase (submit/download/error/row_deadline) — never user-facing.
  { prefix: 'nsfw_scan_failed:', label: () => 'Pemindaian NSFW gagal' },
  { prefix: 'contains_mention', label: () => '@Mention' },
]

/** Exact-match entries: reason string → display label. */
const FILTER_REASON_EXACT_LABELS: ReadonlyMap<string, string> = new Map<string, string>([
  ['ai_image:all_providers_failed', 'Vision AI: All Providers Failed'],
  ['ai_image:filter_error', 'Vision AI: Filter Error'],
  ['nsfw_scan_escalated', 'Pemindaian NSFW gagal (3×)'],
  ['ai:skipped_error', 'AI: Skipped (error)'],
  ['ai:provider_error', 'AI: Provider Error'],
  ['ai:all_providers_failed', 'Pemeriksaan AI gagal'],
  ['ai:filter_error', 'AI: Filter Error'],
  ['blocked_word', 'Kata terlarang'],
  ['nsfw_word', 'NSFW word'],
  ['self_harm', 'Bahaya diri'],
  ['csam_sexual', 'CSAM (sexual)'],
  ['csam_age', 'CSAM (age)'],
  ['solicitation_sexual', 'Ajakan (seksual)'],
  ['solicitation_payment', 'Solicitation (payment)'],
  ['ai_image', 'Vision AI'],
  ['ai', 'AI'],
  ['nsfw_flagged', 'NSFW Image'],
  ['nsfw_rejected', 'NSFW Rejected'],
  ['contains_url', 'Link'],
  ['contains_email', 'Email'],
  ['contains_nik', 'NIK'],
  ['contains_ip_address', 'IP'],
  ['contains_npwp', 'NPWP'],
  ['contains_phone', 'No. HP'],
  ['caps_spam', 'Huruf kapital semua dilarang'],
  ['repeated_characters', 'Spam karakter berulang'],
  ['too_short', 'Terlalu pendek'],
  ['duplicate', 'Duplikat'],
])

/** Convert a filter reason string into a human-readable label for display. */
export function getFilterReasonLabel(reason: string): string {
  // Check exact matches first (more specific than prefix matches)
  const exact = FILTER_REASON_EXACT_LABELS.get(reason)
  if (exact) return exact

  // Check prefix matches
  for (const entry of FILTER_REASON_PREFIX_LABELS) {
    if (reason.startsWith(entry.prefix)) {
      return entry.label(reason.slice(entry.prefix.length))
    }
  }

  return reason
}

export function parseFilterReasons(filterReasons: string | null): string[] {
  if (!filterReasons) return []
  try {
    const parsed = JSON.parse(filterReasons)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// --- Date Formatter ---

export function formatDate(dateStr: string, timeZone?: string): string {
  return new Date(dateStr).toLocaleString(
    'id-ID',
    timeZone === undefined
      ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone },
  )
}

// --- Relative Time Formatter ---

/** Relative time for activity lines: "baru saja", "N menit lalu",
 *  "N jam lalu", "N hari lalu", "N bulan lalu", "N tahun lalu".
 *  Month/year buckets (not an absolute-date cutoff) keep join dates
 *  readable — "bergabung 3 bulan lalu" is exactly the coarse signal
 *  the line exists for, and every age gets a label. Non-parsable
 *  input returns the raw string (total, honest). */
export function formatRelativeTime(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  if (!Number.isFinite(ms)) return dateStr
  if (ms < 60_000) return 'baru saja'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} menit lalu`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} jam lalu`
  const days = Math.floor(hours / 24)
  if (days <= 30) return `${days} hari lalu`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} bulan lalu`
  return `${Math.floor(months / 12)} tahun lalu`
}

// --- Day-Key Formatter ---

/** Format a 'YYYY-MM-DD' day key as a short id-ID day label: '28 Sep'.
 *  The analytics charts' sparse x-axis labels (first/middle/last slot) —
 *  built beside formatDate so day labels never grow a component-local
 *  formatter. Parses the key as UTC midnight so the calendar date is
 *  exactly the key's, regardless of the runtime timezone. */
export function formatDayShort(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined || !Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return dayKey
  }
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

// --- Count Formatter ---

/** Format a count with id-ID integer grouping: 4100 → '4.100' — the count
 *  sibling of formatIdr (money) and formatDate (dates). Every analytics
 *  count surface (footers, axis ticks, leaderboard values, funnel stages)
 *  renders through here so grouping never drifts per-component. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(n)
}

// --- Countdown Formatter ---

/** M:SS with zero-padded seconds — the shared countdown label formula
 *  (the payment expiry label, the 429 retry line, the admin-login
 *  lockout line). */
export function formatMmSs(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}
