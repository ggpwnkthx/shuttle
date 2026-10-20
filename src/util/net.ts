/**
 * IP address helpers used for the trusted proxy evaluation.
 *
 * The parsing and the matching of the addresses and of the CIDR ranges are
 * done by `ipaddr.js`: the gateway does not implement a format that a
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

/** The compiled form of a list of ranges. */
interface CompiledRanges {
  ranges: Range[]
}

/**
 * The compiled ranges, by the key of the list they came from.
 *
 * The trusted proxy ranges change only when the configuration is reloaded,
 * so compiling them once per list keeps the request path cheap. The cache is
 * bounded, a pathological configuration cannot grow it without limit.
 */
const compiled = new LRUCache<string, CompiledRanges>({ max: 32 })

/**
 * Parses a CIDR range (`10.0.0.0/8`) or a single address (`127.0.0.1`).
 *
 * The format is parsed by `ipaddr.js`: `parseCIDR` owns the range syntax and
 * rejects a prefix that is out of range, a single address is parsed with
 * `parse` and covers exactly itself.
 *
 * A value that cannot be parsed is rejected: it never matches, instead of
 * making the whole list unusable.
 */
function parseCidr(value: string): Range | null {
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
  // The family of the address decides the length of the prefix.
  const prefix = address.kind() === 'ipv4' ? 32 : 128
  return { address, prefix, family: address.kind() }
}

/** Compiles a list of ranges, dropping the ones that cannot be parsed. */
function compileRanges(ranges: string[]): CompiledRanges {
  const compiledRanges: Range[] = []
  for (const range of ranges) {
    const parsed = parseCidr(range)
    if (parsed) compiledRanges.push(parsed)
  }
  return { ranges: compiledRanges }
}

/** The compiled form of a list of ranges, compiled once per list. */
function compiledRanges(ranges: string[]): CompiledRanges {
  const key = ranges.join(',')
  const cached = compiled.get(key)
  if (cached) return cached
  const result = compileRanges(ranges)
  compiled.set(key, result)
  return result
}

/**
 * Reports whether an address is covered by one of the given ranges.
 *
 * A range is a CIDR range (`10.0.0.0/8`) or a single address
 * (`127.0.0.1`). A range of another address family never matches.
 */
export function ipInRanges(ip: string, ranges: string[]): boolean {
  const trimmed = ip.trim()
  if (!trimmed) return false

  let address: Address
  try {
    address = ipaddr.parse(trimmed)
  } catch {
    return false
  }

  for (const range of compiledRanges(ranges).ranges) {
    if (range.family !== address.kind()) continue
    if (address.match(range.address, range.prefix)) return true
  }
  return false
}
