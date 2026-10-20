/**
 * The addresses of the network.
 *
 * The trusted proxy evaluation needs to know whether an address belongs to a
 * range. The syntax of the ranges (`10.0.0.0/8`) and of the addresses is
 * parsed by a library: the gateway does not implement a format that a
 * library already does.
 */

import ipaddr from 'ipaddr.js'
import { LRUCache } from 'lru-cache'

type Address = ipaddr.IPv4 | ipaddr.IPv6

/** A compiled range: a network and the length of its prefix. */
interface Range {
  address: Address
  prefix: number
  family: 'ipv4' | 'ipv6'
}

/**
 * The compiled ranges, by the key of the list they came from.
 *
 * The ranges of the trusted proxies change only when the configuration is
 * reloaded, so compiling them once per list keeps the request path cheap.
 * The cache is bounded: a pathological configuration cannot grow it without
 * limit.
 */
const compiled = new LRUCache<string, Range[]>({ max: 32 })

/**
 * Parses a range (`10.0.0.0/8`) or a single address (`127.0.0.1`).
 *
 * A value that cannot be parsed is dropped: it never matches, instead of
 * making the whole list unusable.
 */
function parseRange(value: string): Range | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.includes('/')) {
    try {
      const [address, prefix] = ipaddr.parseCIDR(trimmed)
      return { address, prefix, family: address.kind() }
    } catch {
      return null
    }
  }
  let address: Address
  try {
    address = ipaddr.parse(trimmed)
  } catch {
    return null
  }
  return { address, prefix: address.kind() === 'ipv4' ? 32 : 128, family: address.kind() }
}

/**
 * Reports whether an address is covered by one of the given ranges.
 *
 * A range is a CIDR range (`10.0.0.0/8`) or a single address
 * (`127.0.0.1`). A range of another address family never matches.
 */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  const trimmed = ip.trim()
  if (!trimmed) return false
  let address: Address
  try {
    address = ipaddr.parse(trimmed)
  } catch {
    return false
  }
  const key = ranges.join(',')
  let compiledRanges = compiled.get(key)
  if (!compiledRanges) {
    compiledRanges = []
    for (const range of ranges) {
      const parsed = parseRange(range)
      if (parsed) compiledRanges.push(parsed)
    }
    compiled.set(key, compiledRanges)
  }
  for (const range of compiledRanges) {
    if (range.family !== address.kind()) continue
    if (address.match(range.address, range.prefix)) return true
  }
  return false
}
