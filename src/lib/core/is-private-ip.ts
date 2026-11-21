/**
 * Checks whether a hostname points to a private/internal IP address.
 * Used for SSRF protection — prevents proxy URLs from reaching internal services.
 *
 * Covers: unspecified (0.0.0.0/8), RFC 1918, loopback, link-local, cloud
 * metadata, IPv6 ULA, IPv6 link-local, IPv4-mapped IPv6, and NAT64-mapped
 * IPv4.
 *
 * The production caller feeds `new URL(...).hostname`, which serializes IPv6
 * hosts in canonical compressed HEX (e.g. "[::ffff:a9fe:a9fe]" — a dotted
 * quad never survives serialization). The IPv6 path therefore parses the full
 * group structure and checks ranges by bit math, not by string prefix, and
 * unwraps the two mapping prefixes that embed an IPv4 address in their low
 * 32 bits (::ffff:0:0/96 and 64:ff9b::/96) into the shared IPv4 ranges —
 * both spellings of the same target answer identically.
 */

import { element } from '@/lib/core/utils'

/** The eight 16-bit groups of a parsed IPv6 address. */
type IPv6Groups = [number, number, number, number, number, number, number, number]

/**
 * The unspecified, RFC 1918, loopback, and link-local IPv4 ranges —
 * single-sourced so the plain dotted-decimal path and both IPv6 prefixes
 * that embed an IPv4 address answer identically for the same target.
 */
function isPrivateIPv4Range([a, b]: [number, number, number, number]): boolean {
  // Unspecified / "this network" 0.0.0.0/8 (RFC 791) — reserved, never
  // routable; includes 0.0.0.0 itself, the IPv4 spelling of "::", and every
  // mapped/NAT64 unwrap of it
  if (a === 0) return true
  // Loopback 127.0.0.0/8
  if (a === 127) return true
  // Link-local 169.254.0.0/16 (AWS/GCP metadata endpoint)
  if (a === 169 && b === 254) return true
  // RFC 1918: 10.0.0.0/8
  if (a === 10) return true
  // RFC 1918: 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true
  // RFC 1918: 192.168.0.0/16
  if (a === 192 && b === 168) return true
  return false
}

/**
 * Parse a dotted-decimal IPv4 literal into its octets. Strict decimal only:
 * the URL parser canonicalizes the lenient spellings (hex 0x.., octal 0..)
 * to dotted-decimal before the guard ever sees them, so anything else is a
 * malformed literal, not an address.
 */
function parseIPv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  // Four entries by construction (parts.length === 4 above)
  return octets as [number, number, number, number]
}

/**
 * Parse a bare (bracket-stripped) IPv6 literal into its eight 16-bit groups,
 * expanding the one legal "::" run of zeros. Accepts an embedded IPv4 dotted
 * tail (e.g. "::ffff:1.2.3.4") — the form direct callers write even though
 * the URL parser serializes it as hex. Returns null for malformed literals;
 * callers treat that as "not private", the same way the IPv4 path treats a
 * non-literal.
 */
function parseIPv6Groups(bare: string): IPv6Groups | null {
  const halves = bare.split('::')
  // At most one "::" run of zeros is legal
  if (halves.length > 2) return null

  // The embedded IPv4 tail is only legal as the final piece of the whole
  // address — head sides (and every non-final piece) must be pure hex.
  const parseSide = (side: string, ipv4TailAllowed: boolean): number[] | null => {
    if (side === '') return []
    const pieces = side.split(':')
    const groups: number[] = []
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes('.')) {
        if (!ipv4TailAllowed || index !== pieces.length - 1) return null
        const embedded = parseIPv4Octets(piece)
        if (!embedded) return null
        groups.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3])
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null
      groups.push(parseInt(piece, 16))
    }
    return groups
  }

  const head = parseSide(element(halves, 0), halves.length === 1)
  if (head === null) return null

  if (halves.length === 2) {
    // Index 1 exists exactly when length is 2 (guarded above) — the bound is
    // caller-guaranteed, so element()'s cast is sound.
    const tail = parseSide(element(halves, 1), true)
    if (tail === null) return null
    // "::" stands for ONE OR MORE zero groups — a full eight on both sides
    // leaves no room for the run itself
    if (head.length + tail.length > 7) return null
    const zeros = 8 - head.length - tail.length
    // Eight entries by construction (head + zeros + tail === 8)
    return [...head, ...Array<number>(zeros).fill(0), ...tail] as IPv6Groups
  }

  // No "::" — the full uncompressed form is exactly eight groups
  if (head.length !== 8) return null
  return head as IPv6Groups
}

/**
 * Range checks on the eight parsed groups. fe80::/10 and fc00::/7 are matched
 * with bit masks on the first group — a string prefix would misclassify
 * short hextets like "fce" or "fd5", which are global unicast. The unspecified
 * address blocks here by value (::); its IPv4 spelling (0.0.0.0, bare or
 * mapped/NAT64-unwrapped) blocks in the shared IPv4 ranges — every "no
 * address" form answers identically.
 */
function isPrivateIPv6([g0, g1, g2, g3, g4, g5, g6, g7]: IPv6Groups): boolean {
  // Unspecified (::)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) return true
  // Loopback (::1)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) both embed an IPv4
  // address in the low 32 bits — unwrap and run the shared IPv4 ranges
  if (
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    || (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
  ) {
    return isPrivateIPv4Range([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff])
  }
  // Link-local (fe80::/10)
  if ((g0 & 0xffc0) === 0xfe80) return true
  // Unique local (fc00::/7)
  if ((g0 & 0xfe00) === 0xfc00) return true
  return false
}

export function isPrivateIP(hostname: string): boolean {
  // Named hostnames
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return true
  }

  // IPv6 — new URL().hostname wraps IPv6 in brackets (e.g. "[fc00::1]");
  // strip them, then parse the full group structure
  if (hostname.includes(':')) {
    const bare = hostname.replace(/^\[|\]$/g, '')
    const groups = parseIPv6Groups(bare)
    return groups !== null && isPrivateIPv6(groups)
  }

  // IPv4 dotted-decimal
  const octets = parseIPv4Octets(hostname)
  return octets !== null && isPrivateIPv4Range(octets)
}
