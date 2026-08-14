import type { Multiaddr } from '@multiformats/multiaddr'

/**
 * Multiaddr 13 — shipped with libp2p v3 — dropped `protoNames()` and
 * `nodeAddress()` in favour of a single `getComponents()` accessor. These two
 * helpers keep the call sites readable rather than spreading component
 * filtering through the UI.
 */
export function protoNames(maddr: Multiaddr): string[] {
  return maddr.getComponents().map((c) => c.name)
}

const HOST_PROTOCOLS = new Set(['ip4', 'ip6', 'dns', 'dns4', 'dns6', 'dnsaddr'])

/** Host and port of an address, or null for addresses that carry neither. */
export function nodeAddress(maddr: Multiaddr): { address: string; port?: number } | null {
  const components = maddr.getComponents()
  const host = components.find((c) => HOST_PROTOCOLS.has(c.name))
  if (host?.value == null) return null

  const port = components.find((c) => c.name === 'tcp' || c.name === 'udp')
  return { address: host.value, port: port?.value != null ? Number(port.value) : undefined }
}
