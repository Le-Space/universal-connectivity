export const CHAT_TOPIC = 'universal-connectivity'
export const CHAT_FILE_TOPIC = 'universal-connectivity-file'
export const PUBSUB_PEER_DISCOVERY = 'universal-connectivity-browser-peer-discovery'
export const FILE_EXCHANGE_PROTOCOL = '/universal-connectivity-file/1'
export const DIRECT_MESSAGE_PROTOCOL = '/universal-connectivity/dm/1.0.0'

// Extension system - uses identify protocol for discovery and direct streams for communication
// Protocol format: /uc/extension/{extensionId}/{version}
export const EXTENSION_PROTOCOL_PREFIX = '/uc/extension/'

export const CIRCUIT_RELAY_CODE = 290

export const MIME_TEXT_PLAIN = 'text/plain'

// 👇 Relay discovery
// This used to be a single hard-coded bootstrap peer ID resolved through
// delegated routing. That peer is gone — the lookup returns an empty peer list
// — and a browser that finds no relay never gets a reachable address, so it can
// neither be dialled nor discover anyone.
//
// Relays now self-register on a public Aleph channel and republish every 6 h,
// so discovery asks that channel for whatever is current instead of trusting a
// constant. The profile scopes the answer: several relay implementations share
// the channel, and a browser that picks a relay from the wrong one never forms
// a shared circuit. Extensions (e.g. the Yjs spreadsheet) resolve the same
// profile — that agreement is what puts both apps on one relay.
export const RELAY_BOOTSTRAP_PROFILE = 'uc-go-peer'

// Snapshot from the same Aleph channel, used only when discovery cannot be
// reached (offline, API down). Every relay deploy mints a new peer ID, so this
// list goes stale by design — which is why it is the fallback, not the source.
export const RELAY_BOOTSTRAP_FALLBACK = [
  '/dns4/they-idea-quick-soda.2n6.me/tcp/443/tls/ws/p2p/16Uiu2HAkuwNWxbdqi4QAiX5HNNVA8hmk2Ya5LAAc5KUdSNwjLH7L',
  '/dns6/they-idea-quick-soda.2n6.me/tcp/443/tls/ws/p2p/16Uiu2HAkuwNWxbdqi4QAiX5HNNVA8hmk2Ya5LAAc5KUdSNwjLH7L',
  '/dns4/arena-soul-sniff-cube.2n6.me/tcp/443/tls/ws/p2p/16Uiu2HAmRCbUxTCZmDwPtRM7VnmjFHYxqCeQtGWLXG7ssLRczor2',
  '/dns6/arena-soul-sniff-cube.2n6.me/tcp/443/tls/ws/p2p/16Uiu2HAmRCbUxTCZmDwPtRM7VnmjFHYxqCeQtGWLXG7ssLRczor2',
]
