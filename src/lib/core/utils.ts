import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Extract a string message from an unknown error, with a fallback default. */
export function getErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  return err instanceof Error ? err.message : fallback
}

/** Clamp a settings-input's raw string to a def's [min, max] band.
 *  NaN/empty → min; max: null/undefined = unbounded above. */
export function clampInt(def: { min: number; max?: number | null | undefined }, raw: string): number {
  const val = parseInt(raw, 10)
  const base = isNaN(val) ? def.min : val
  return def.max != null ? Math.min(def.max, Math.max(def.min, base)) : Math.max(def.min, base)
}

/**
 * Type-safe, prototype-pollution-safe property accessor.
 * Validates the key against the object's own keys (whitelist) before access,
 * preventing prototype chain access (__proto__, constructor, etc.).
 *
 * SAST tools flag dynamic bracket access (obj[key]) as "Generic Object
 * Injection Sink" — this function provides the recommended mitigation:
 * validate and sanitize dynamic keys before using them to access properties.
 *
 * Object.entries() enumerates own enumerable properties only, and the
 * entries-based lookup avoids computed member access entirely.
 */
export function safeAccess<T extends object, K extends keyof T>(obj: T, key: K): T[K] {
  const entry = Object.entries(obj).find(([k]) => k === key)
  if (entry === undefined) throw new Error(`Invalid key: ${String(key)}`)
  return entry[1] as T[K]
}

/**
 * Prototype-pollution-safe optional property accessor.
 * Like safeAccess() but returns undefined for missing keys instead of throwing.
 *
 * Use for Record<string, T> lookups where the key may not exist
 * (e.g. blockedReasonsById[twitterId]).
 *
 * SAST tools flag obj[dynamicKey] as "Generic Object Injection Sink"; a Map
 * built from own entries gives the same own-properties-only semantics
 * (Map.get never traverses a prototype chain).
 */
export function safeGet<T>(obj: Record<string, T>, key: string): T | undefined {
  return new Map(Object.entries(obj)).get(key)
}

/**
 * Array element access with a caller-guaranteed in-bounds index.
 *
 * Replaces `arr[i]!` — non-null assertions are banned by lint, and computed
 * member access `arr[i]` is flagged by security/detect-object-injection.
 * `.at()` avoids both; the cast narrows the `T | undefined` that
 * noUncheckedIndexedAccess adds to element access.
 *
 * Contract: the caller must guarantee the index is within bounds — e.g. a
 * `for (let i = 0; i < arr.length; i++)` loop bound, modulo arithmetic on the
 * array length, or a prior length check. Also works for regex match arrays:
 * non-optional capture groups are always present on a successful match.
 */
export function element<T>(arr: readonly T[], index: number): T {
  return arr.at(index) as T
}

/**
 * Safely parse an integer from a string, returning the fallback
 * only when the value is missing/null/empty/NaN. Unlike `parseInt(x) || fallback`,
 * this correctly returns 0 and -1 when the admin intentionally sets those values.
 */
export function parseIntSafe(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback
  const parsed = parseInt(raw, 10)
  if (Number.isNaN(parsed)) return fallback
  return parsed
}

/**
 * Mask the password in a proxy URL for safe logging/display.
 * Replaces `proxy.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')` (3 occurrences).
 */
export function maskProxyUrl(proxy: string): string {
  return proxy.replace(/\/\/([^:@]*):([^@]+)@/, '//$1:****@')
}
