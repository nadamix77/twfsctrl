// ============================================================
// log.ts — Controller debug logging (PRD §14 O1/O2)
//
// Mirrors the instance DEBUG= convention with controller namespaces:
//   DEBUG=controller        — everything
//   DEBUG=controller:fanout,controller:queue,controller:auth
// Structured per-instance timing lines (`instance=twfs ms=812 status=200`)
// carry NO payloads (NFR-S5: no secrets, no submission content).
// ============================================================

function namespacesEnabled(): Set<string> {
  const raw = process.env.DEBUG ?? ''
  const enabled = new Set<string>()
  for (const part of raw.split(',').map((p) => p.trim().toLowerCase())) {
    if (!part) continue
    enabled.add(part)
    if (part === 'controller') {
      enabled.add('controller:fanout')
      enabled.add('controller:queue')
      enabled.add('controller:auth')
      enabled.add('controller:registry')
    }
  }
  return enabled
}

const enabled = namespacesEnabled()

/** The single console handle for the controller (mirrors debug.ts —
 *  `no-console` stays active everywhere else). */
const consoleRef = console

export function controllerDebug(ns: 'controller:fanout' | 'controller:queue' | 'controller:auth' | 'controller:registry', ...args: unknown[]): void {
  if (enabled.has(ns)) consoleRef.log(`[${ns}]`, ...args)
}

export function controllerError(...args: unknown[]): void {
  consoleRef.error('[controller]', ...args)
}
