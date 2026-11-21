// ============================================================
// parse.ts — defensive readers for instance JSON payloads
//
// Every new fan-out surface (submitters, payments, settings,
// filter, AI, analytics) parses instance bodies through these
// helpers: unknown fields ignored, wrong-typed fields coerced to
// null — an instance drift can never crash the merge (NFR-X1,
// same doctrine as parseStatsSnapshot in overview.ts).
// ============================================================

export function readNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function readInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

export function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function readBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

export function readIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return isNaN(Date.parse(v)) ? null : v
}

export function readStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** Record<string, number> — only finite numeric values survive. Built
 *  via entries + fromEntries — no computed member writes (SAST idiom). */
export function readNumRecord(v: unknown): Record<string, number> | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null
  const entries = Object.entries(v).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  )
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** Record<string, number | boolean> — the monetization group shape. */
export function readNumBoolRecord(v: unknown): Record<string, number | boolean> | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null
  const entries = Object.entries(v).filter(
    (entry): entry is [string, number | boolean] =>
      (typeof entry[1] === 'number' && Number.isFinite(entry[1])) || typeof entry[1] === 'boolean',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** Record<string, unknown> — opaque object groups (filterRules etc.). */
export function readObjRecord(v: unknown): Record<string, unknown> | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null
  return Object.keys(v).length > 0 ? { ...v } : null
}

/** Standard pagination block shared by the instance list endpoints. */
export interface ListPagination {
  total: number
  hasMore: boolean
}

export function readPagination(body: unknown, itemsKey: string): { items: unknown[] } & ListPagination {
  if (body == null || typeof body !== 'object') return { items: [], total: 0, hasMore: false }
  const b = body as Record<string, unknown>
  // Dynamic items key (submitters vs orders) — entries-find, no computed
  // member access (SAST idiom).
  const itemsEntry = Object.entries(b).find(([key]) => key === itemsKey)
  const items = Array.isArray(itemsEntry?.[1]) ? (itemsEntry[1] as unknown[]) : []
  const p = (b.pagination ?? null) as Record<string, unknown> | null
  // /api/admin/submitters exposes totalCount/hasMore at the top level;
  // /api/admin/payments exposes total/hasMore — accept all spellings.
  const total =
    readInt(p?.total) ??
    readInt(b.total) ??
    readInt(b.totalCount) ??
    items.length
  const hasMore = (p?.hasMore ?? b.hasMore) === true
  return { items, total, hasMore }
}
