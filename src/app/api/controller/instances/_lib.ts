// ============================================================
// _lib.ts — shared request validation for the controller instance
// registry routes (POST /api/controller/instances and
// PATCH /api/controller/instances/[id])
//
// One validation vocabulary for both writes so the create form and the
// edit form can never disagree on what a valid name/handle/color is.
// Normalization itself lives in src/lib/controller/instance-url.ts —
// this module only unwraps its `value | null | {error}` results into
// route-friendly discriminated unions.
// ============================================================

import { normalizeColorTag, normalizeHandle } from '@/lib/controller/instance-url'

/** Display-name bounds (FR-B1: unique, display only). */
export const INSTANCE_NAME_MAX = 40
/** Write-only credential bound — mirrors the instance ADMIN_PASSWORD cap. */
export const INSTANCE_PASSWORD_MAX = 200

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export type FieldCheck = { ok: true; value: string } | { ok: false; error: string }
export type OptionalFieldCheck = { ok: true; value: string | null } | { ok: false; error: string }

/** Validate a display name: trimmed, 1–40 chars, no control characters. */
export function checkInstanceName(value: unknown): FieldCheck {
  if (typeof value !== 'string') return { ok: false, error: 'Nama instance wajib diisi' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, error: 'Nama instance wajib diisi' }
  if (trimmed.length > INSTANCE_NAME_MAX) {
    return { ok: false, error: `Nama instance maksimal ${INSTANCE_NAME_MAX} karakter` }
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return { ok: false, error: 'Nama instance tidak boleh mengandung karakter kontrol' }
  }
  return { ok: true, value: trimmed }
}

/** Length guard for the write-only instance admin password (≤200 chars).
 *  Presence/blankness policy differs per verb and stays in the routes. */
export function checkAdminPasswordLength(value: string): string | null {
  return value.length > INSTANCE_PASSWORD_MAX
    ? `Password admin instance maksimal ${INSTANCE_PASSWORD_MAX} karakter`
    : null
}

/** Unwrap a normalizer result (`string | null | {error}`) into a
 *  discriminated union the routes can branch on without narrowing casts. */
function unwrapNormalizer(result: string | null | { error: string }): OptionalFieldCheck {
  if (typeof result === 'object' && result !== null) return { ok: false, error: result.error }
  return { ok: true, value: result }
}

/** Validate a menfess X handle (display only; null clears). */
export function checkHandle(value: unknown): OptionalFieldCheck {
  return unwrapNormalizer(normalizeHandle(value))
}

/** Validate a badge color tag (hex; null clears). */
export function checkColorTag(value: unknown): OptionalFieldCheck {
  return unwrapNormalizer(normalizeColorTag(value))
}
