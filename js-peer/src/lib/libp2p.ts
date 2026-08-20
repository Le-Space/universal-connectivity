import { createDelegatedRoutingV1HttpApiClient } from '@helia/delegated-routing-v1-http-api-client'
import { createLibp2p } from 'libp2p'
import { FaultTolerance } from '@libp2p/interface'
import { identify, identifyPush } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { sha256 } from 'multiformats/hashes/sha2'
import type { Connection, Libp2p, Message, SignedMessage } from '@libp2p/interface'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { webTransport } from '@libp2p/webtransport'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { ping } from '@libp2p/ping'
import { CHAT_FILE_TOPIC, CHAT_TOPIC, PUBSUB_PEER_DISCOVERY } from './constants'
import {
  resolveRelayBootstrapAddrs,
  selectAnnounceAddrs,
  toCircuitListenAddrs,
  type RelayBootstrapResolution,
} from './aleph-bootstrap'
import { directMessage } from './direct-message'
import { enable, forComponent } from './logger'
import type { Libp2pType } from '@/context/ctx'

const log = forComponent('libp2p')
const DEFAULT_DELEGATED_ROUTING_URL = 'https://delegated-ipfs.dev'

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function getConfiguredRelayListenAddrs(): string[] {
  return parseCsvEnv(process.env.NEXT_PUBLIC_RELAY_LISTEN_ADDRS)
}

function getDelegatedRoutingURL(): string {
  const configured = process.env.NEXT_PUBLIC_DELEGATED_ROUTING_URL?.trim()
  if (configured) {
    return configured
  }

  return DEFAULT_DELEGATED_ROUTING_URL
}

export async function startLibp2p(): Promise<Libp2pType> {
  enable('ui*,libp2p*,-libp2p:connection-manager*,-*:trace')

  const delegatedClient = createDelegatedRoutingV1HttpApiClient(getDelegatedRoutingURL())
  const relayBootstrap = await getRelayBootstrapAddrs()
  const relayBootstrapAddrs = relayBootstrap.addresses
  if (relayBootstrap.error) {
    log.error('aleph relay discovery failed, using the baked snapshot: %o', relayBootstrap.error)
  }
  log('starting libp2p with relayBootstrapAddrs from %s: %o', relayBootstrap.source, relayBootstrapAddrs)

  const libp2p = await createLibp2p({
    addresses: {
      // A browser has no dialable address of its own: it needs a circuit
      // reservation on a relay before anyone can reach it, and
      // `circuitRelayTransport()` only reserves on relays named here. Without
      // these entries the node starts, connects out, announces zero addresses,
      // and is never found by anyone — which is what leaves the peer list at
      // just the relays.
      listen: ['/webrtc', ...toCircuitListenAddrs(relayBootstrapAddrs)],
      announceFilter: (multiaddrs) => selectAnnounceAddrs(multiaddrs),
    },
    transportManager: {
      // One unreachable relay must not keep the app from starting. The default
      // is fatal for any failed listen address, and that is how a single stale
      // baked relay turned the deployed build into a permanent
      // "Initializing libp2p peer" screen.
      faultTolerance: FaultTolerance.NO_FATAL,
    },
    transports: [
      webTransport(),
      webSockets(),
      webRTC(),
      webRTCDirect(),
      // Bound the wait for a circuit reservation. `createLibp2p()` does not
      // resolve until every listen address has settled, and the whole UI —
      // including the extension manager, which only starts once the libp2p
      // context hands out a node — is gated on that promise. Without a bound,
      // one slow relay leaves the app on "Initializing libp2p peer" for
      // minutes while the node underneath is already connected and talking.
      circuitRelayTransport({ reservationCompletionTimeout: 10_000 }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
      pubsubPeerDiscovery({
        interval: 10_000,
        topics: [PUBSUB_PEER_DISCOVERY],
        listenOnly: false,
      }),
    ],
    services: {
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        msgIdFn: msgIdFnStrictNoSign,
        ignoreDuplicatePublishError: true,
      }),
      delegatedRouting: () => delegatedClient,
      identify: identify(),
      // Without this, a peer's view of us is frozen at whatever we announced
      // during the one identify run on connect. Relay and WebRTC connections
      // are established while we are still starting, so peers saw only
      // id/ping/webrtc-signaling and never learned that gossipsub, direct
      // messages or anything else had come up — measured on the spreadsheet's
      // peer store, whose entry for us listed exactly those three protocols.
      // Gossipsub's topology matches on `/meshsub/*`, so it never fired and
      // the two nodes stayed connected without ever forming a mesh.
      identifyPush: identifyPush(),
      directMessage: directMessage(),
      ping: ping(),
    },
  })

  libp2p.services.pubsub.subscribe(CHAT_TOPIC)
  libp2p.services.pubsub.subscribe(CHAT_FILE_TOPIC)

  libp2p.addEventListener('self:peer:update', ({ detail: { peer } }) => {
    const multiaddrs = peer.addresses.map(({ multiaddr }) => multiaddr)
    log('changed multiaddrs: peer %s multiaddrs: %o', peer.id.toString(), multiaddrs)
  })

  libp2p.addEventListener('peer:discovery', (event) => {
    const { multiaddrs, id } = event.detail

    const connectionCount = libp2p.getConnections(id)?.length ?? 0
    if (connectionCount > 0) {
      log(
        'peer %s rediscovered with %d existing connection(s), continuing dial attempt',
        id.toString(),
        connectionCount,
      )
    }

    void dialWebRTCMaddrs(libp2p, multiaddrs)
  })

  void (async () => {
    for (const addr of relayBootstrapAddrs) {
      try {
        log('dialling configured relay bootstrap address: %s', addr)
        await connectToMultiaddr(libp2p)(multiaddr(addr))
      } catch (error) {
        log.error('failed to dial configured relay bootstrap address %s: %o', addr, error)
      }
    }
  })().catch((error) => {
    log.error('bootstrap dial error: %o', error)
  })

  return libp2p as Libp2pType
}

export async function msgIdFnStrictNoSign(msg: Message): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const signedMessage = msg as SignedMessage
  const encodedSeqNum = enc.encode(signedMessage.sequenceNumber.toString())
  return await sha256.encode(encodedSeqNum)
}

async function dialWebRTCMaddrs(libp2p: Libp2p, multiaddrs: Multiaddr[]): Promise<void> {
  const webRtcMaddrs = multiaddrs.filter((maddr) => maddr.protoNames().includes('webrtc'))
  log('dialling WebRTC multiaddrs: %o', webRtcMaddrs)

  for (const addr of webRtcMaddrs) {
    try {
      log('attempting to dial webrtc multiaddr: %o', addr)
      await libp2p.dial(addr)
      return
    } catch (error) {
      log.error('failed to dial webrtc multiaddr: %o %o', addr, error)
    }
  }
}

export const connectToMultiaddr = (libp2p: Libp2p) => async (address: Multiaddr) => {
  log('dialling: %a', address)
  try {
    const conn = await libp2p.dial(address)
    log('connected to %p on %a', conn.remotePeer, conn.remoteAddr)
    return conn
  } catch (error) {
    console.error(error)
    throw error
  }
}

async function getRelayBootstrapAddrs(): Promise<RelayBootstrapResolution> {
  const configuredRelayListenAddrs = getConfiguredRelayListenAddrs()
  if (configuredRelayListenAddrs.length > 0) {
    log('using NEXT_PUBLIC_RELAY_LISTEN_ADDRS override as explicit relay bootstrap addresses')
    return { addresses: configuredRelayListenAddrs, source: 'baked' }
  }

  return resolveRelayBootstrapAddrs()
}

export const getFormattedConnections = (connections: Connection[]) =>
  connections.map((conn) => ({
    peerId: conn.remotePeer,
    protocols: [...new Set(conn.remoteAddr.protoNames())],
  }))
