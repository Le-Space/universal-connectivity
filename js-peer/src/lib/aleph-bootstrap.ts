import { discoverAlephBootstrapMultiaddrs } from '@le-space/aleph-bootstrap'
import { RELAY_BOOTSTRAP_FALLBACK, RELAY_BOOTSTRAP_PROFILE } from './constants'
import type { Multiaddr } from '@multiformats/multiaddr'

const DISCOVERY_TIMEOUT_MS = 15_000

export interface RelayBootstrapResolution {
  addresses: string[]
  source: 'aleph' | 'baked'
  error?: Error
}

/**
 * Fetch with a deadline, so an unreachable Aleph API costs a few seconds
 * rather than stalling startup in front of the chat UI.
 */
function fetchWithTimeout(timeoutMs: number): typeof fetch {
  return (input, init = {}) =>
    fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
}

/**
 * Resolve the relays this browser can reach from the Aleph bootstrap channel.
 *
 * Discovery runs first and the baked snapshot is only the fallback: a snapshot
 * is a photograph of a relay set that rotates on every deploy, and preferring
 * it is exactly how the previous hard-coded bootstrap survived long after the
 * peer behind it had gone.
 */
export async function resolveRelayBootstrapAddrs(
  {
    profile = process.env.NEXT_PUBLIC_RELAY_BOOTSTRAP_PROFILE?.trim() || RELAY_BOOTSTRAP_PROFILE,
    fallback = RELAY_BOOTSTRAP_FALLBACK,
  }: { profile?: string; fallback?: readonly string[] } = {},
): Promise<RelayBootstrapResolution> {
  try {
    const discovered = await discoverAlephBootstrapMultiaddrs({
      profile,
      browserDialableOnly: true,
      fetch: fetchWithTimeout(DISCOVERY_TIMEOUT_MS),
    })

    if (discovered.length > 0) {
      return { addresses: discovered, source: 'aleph' }
    }

    return { addresses: [...fallback], source: 'baked' }
  } catch (error) {
    return { addresses: [...fallback], source: 'baked', error: error as Error }
  }
}

/**
 * Turn relay multiaddrs into circuit listen addresses.
 *
 * Only secure-WebSocket relays are listened on. A reservation is attempted for
 * every address here and `start()` waits for all of them to settle, so the
 * WebTransport variants — which a browser cannot reserve a circuit over — would
 * add a startup stall for no reachability, and one relay reachable over both
 * dns4 and dns6 needs only the family this browser actually has.
 */
export function toCircuitListenAddrs(addresses: readonly string[], limit = 1): string[] {
  const seen = new Set<string>()
  const listenAddrs: string[] = []

  for (const address of addresses) {
    if (!address.includes('/tls/ws')) {
      continue
    }

    const peerId = address.split('/p2p/')[1]
    if (peerId && seen.has(peerId)) {
      continue
    }
    if (peerId) {
      seen.add(peerId)
    }

    listenAddrs.push(`${address}/p2p-circuit`)
    if (listenAddrs.length >= limit) break
  }

  return listenAddrs
}

/**
 * Pick the handful of addresses worth announcing.
 *
 * Listening on a circuit multiplies: the relay reports every address it has
 * (ws, raw ports, AutoTLS sni, dns4 and dns6), each becomes a circuit address,
 * and `/webrtc` doubles that again — measured at 96 addresses, roughly 21 KB of
 * strings. Identify caps its message well below that, so the remote rejects the
 * exchange with "message length too long" and learns none of our protocols.
 * Gossipsub's topology matches on `/meshsub/*` in exactly that list, so the mesh
 * never forms and the extension manager never sees `/uc/extension/...` — over a
 * connection that otherwise pings fine in both directions.
 *
 * One browser-dialable address per relay is enough to be reached.
 */
export function selectAnnounceAddrs(multiaddrs: Multiaddr[], limit = 4): Multiaddr[] {
  const all = multiaddrs.map((ma) => ma.toString())
  const dialable = all.filter((addr) => addr.includes('/p2p-circuit/webrtc'))
  const preferred = dialable.filter((addr) => addr.startsWith('/dns4/') && addr.includes('/tls/ws'))

  const chosen = new Set<string>()
  const seenRelays = new Set<string>()

  for (const addr of [...preferred, ...dialable]) {
    if (chosen.size >= limit) break

    const relay = addr.split('/p2p-circuit')[0].split('/p2p/')[1]
    if (relay != null) {
      if (seenRelays.has(relay)) continue
      seenRelays.add(relay)
    }

    chosen.add(addr)
  }

  // Never announce nothing: an empty list would make us unreachable outright.
  return chosen.size > 0 ? multiaddrs.filter((ma) => chosen.has(ma.toString())) : multiaddrs
}
