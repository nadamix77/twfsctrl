// ============================================================
// bounded-map.ts — Size-bounded insertion for in-memory Map stores
//
// The in-memory stores (limiters, cooldowns, caches) live for the
// process lifetime — without a bound, an attacker spraying distinct
// keys (unique IPs, unique user IDs) grows them without limit.
// This helper gives every store the SAME eviction idiom that
// follow-check and the GoBiz merchant cache established by hand:
// past the cap, the OLDEST entry is evicted (Map iteration is
// insertion order), so a bounded store is a FIFO of recent keys.
//
// Tradeoff (accepted, same as follow-check's): eviction is by age,
// not by activity — under a key flood, an entry that is still
// semantically live (e.g. a locked-out IP's ledger) can be evicted
// before it expires. The cap is sized so that requires 10,000
// distinct keys, at which point per-instance state is noise anyway.
// ============================================================

/**
 * Insert `key → value` into `store`, evicting OLDEST entries first
 * once the store is at `maxEntries`.
 *
 * An insert of an EXISTING key is a plain overwrite (Map.set keeps the
 * key's original insertion position) — overwrites never grow the store,
 * so they never evict. Every growth path goes through this call.
 *
 * @param store      The Map to bound (mutated in place)
 * @param key        Entry key
 * @param value      Entry value
 * @param maxEntries Cap on distinct keys; at the cap the first-inserted
 *                   entry is dropped to make room
 */
export function setBounded<K, V>(store: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (store.has(key)) {
    store.set(key, value)
    return
  }
  // size > 0 guarantees the iterator yields at least one key, and each
  // deleted key shrinks the map — the loop always makes progress, even
  // for a pathological maxEntries <= 0 (it stops once the store is empty).
  while (store.size >= maxEntries && store.size > 0) {
    for (const oldest of store.keys()) {
      store.delete(oldest)
      break
    }
  }
  store.set(key, value)
}
