import { createHash } from 'node:crypto'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Wallet } from 'ethers'

export const ALEPH_API_HOST = 'https://api2.aleph.im'
export const ALEPH_DEFAULT_CHANNEL = 'TEST'
export const CRN_LIST_URL = 'https://crns-list.aleph.sh/crns.json'
export const SCHEDULER_ALLOCATION_URL = 'https://scheduler.api.aleph.cloud/api/v0/allocation'
export const TWO_N_SIX_HASH_URL = 'https://api.2n6.me/api/hash'
export const COUNTRY_IS_API_BASE_URL = 'https://api.country.is'
export const DNS_RESOLVE_URL = 'https://dns.google/resolve'

const SSH_PUBLIC_KEY_PATTERN =
  /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(?:\s+.+)?$/

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeProxyUrl(value) {
  const normalized = asString(value)
  if (!normalized) return null
  return /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isRetryableNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    error?.name === 'AbortError' ||
    message.includes('This operation was aborted') ||
    message.includes('fetch failed') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT')
  )
}

function sanitizeForLog(value, depth = 0) {
  if (value == null) return value
  if (depth >= 4) return '[truncated-depth]'
  if (typeof value === 'string') {
    if (/^0x[a-f0-9]{64,}$/i.test(value)) {
      return `${value.slice(0, 18)}...[redacted]`
    }
    if (value.length > 400) {
      return `${value.slice(0, 400)}...[truncated ${value.length - 400} chars]`
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map((entry) => sanitizeForLog(entry, depth + 1))
    if (value.length > 10) {
      items.push(`[truncated ${value.length - 10} more items]`)
    }
    return items
  }
  if (typeof value === 'object') {
    const result = {}
    const entries = Object.entries(value)
    for (const [index, [key, entryValue]] of entries.entries()) {
      if (index >= 20) {
        result.__truncated__ = `${entries.length - 20} more keys`
        break
      }
      if (key === 'signature') {
        result[key] = '[redacted-signature]'
      } else if (key === 'authorized_keys') {
        result[key] = Array.isArray(entryValue) ? `[redacted ${entryValue.length} ssh key(s)]` : '[redacted ssh keys]'
      } else {
        result[key] = sanitizeForLog(entryValue, depth + 1)
      }
    }
    return result
  }
  return String(value)
}

function emitTrace(trace, phase, details) {
  const logger = trace?.log
  if (typeof logger !== 'function') return
  const prefix = trace?.label ? `[${trace.label}] ` : ''
  logger('notice', `${prefix}${phase}: ${JSON.stringify(sanitizeForLog(details))}`)
}

async function fetchJsonOnce(url, init = {}, timeoutMs = 30000, trace = null) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
  const method = String(init.method ?? 'GET').toUpperCase()
  const bodyForLog =
    typeof init.body === 'string'
      ? (() => {
          try {
            return JSON.parse(init.body)
          } catch {
            return init.body
          }
        })()
      : init.body

  emitTrace(trace, 'http-request', {
    method,
    url: String(url),
    headers: init.headers ?? {},
    body: bodyForLog,
    timeoutMs
  })

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.headers ?? {})
      },
      signal: init.signal ?? controller.signal
    })

    const text = await response.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }

    emitTrace(trace, 'http-response', {
      method,
      url: String(url),
      status: response.status,
      ok: response.ok,
      payload
    })

    return { response, payload }
  } catch (error) {
    emitTrace(trace, 'http-error', {
      method,
      url: String(url),
      error: error instanceof Error ? error.message : String(error)
    })
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson(url, init = {}, timeoutMs = 30000, attempts = 3, trace = null) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        emitTrace(trace, 'http-retry', {
          method: String(init.method ?? 'GET').toUpperCase(),
          url: String(url),
          attempt,
          attempts
        })
      }
      return await fetchJsonOnce(url, init, timeoutMs, trace)
    } catch (error) {
      lastError = error
      if (!isRetryableNetworkError(error) || attempt === attempts) {
        throw error
      }
      await sleep(1000 * attempt)
    }
  }
  throw lastError ?? new Error('Request failed')
}

export function normalizeSshPublicKey(value) {
  return String(value ?? '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isValidSshPublicKey(value) {
  return SSH_PUBLIC_KEY_PATTERN.test(normalizeSshPublicKey(value))
}

export async function fetchCrns(url = CRN_LIST_URL, trace = null) {
  const requestUrl = new URL(url)
  requestUrl.searchParams.set('filter_inactive', 'true')
  const { response, payload } = await fetchJson(requestUrl, {}, 30000, 3, trace)
  if (!response.ok) {
    throw new Error(`CRN list request failed: ${response.status}`)
  }
  return Array.isArray(payload?.crns) ? payload.crns : []
}

function lookupHost(address) {
  try {
    return new URL(address).hostname.trim().toLowerCase()
  } catch {
    return String(address ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/:\d+$/, '')
  }
}

function isIpAddress(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

async function resolveHostIp(host) {
  if (!host) return null
  if (isIpAddress(host)) return host

  for (const type of ['A', 'AAAA']) {
    const url = new URL(DNS_RESOLVE_URL)
    url.searchParams.set('name', host)
    url.searchParams.set('type', type)
    url.searchParams.set('edns_client_subnet', '0.0.0.0/0')

    const { response, payload } = await fetchJson(url)
    if (!response.ok) continue

    const record = Array.isArray(payload?.Answer)
      ? payload.Answer.find((entry) => typeof entry?.data === 'string' && entry.data.trim())
      : null

    if (record?.data) {
      return record.data.trim()
    }
  }

  return null
}

function countryNameFromCode(value) {
  if (!value) return null
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
    return displayNames.of(String(value).toUpperCase()) ?? value
  } catch {
    return value
  }
}

async function lookupIpLocation(ip) {
  const url = new URL(`${COUNTRY_IS_API_BASE_URL}/${encodeURIComponent(ip)}`)
  url.searchParams.set('fields', 'city,subdivision')
  const { response, payload } = await fetchJson(url)
  if (!response.ok) {
    return {
      resolved_ip: ip,
      city: null,
      region: null,
      country: null,
      country_code: null,
      geo_source: null
    }
  }

  const countryCode = asString(payload?.country)?.toUpperCase() ?? null
  return {
    resolved_ip: asString(payload?.ip) ?? ip,
    city: asString(payload?.city),
    region: asString(payload?.subdivision),
    country: countryNameFromCode(countryCode),
    country_code: countryCode,
    geo_source: 'country.is'
  }
}

export async function enrichCrnsWithGeo(crns, trace = null) {
  emitTrace(trace, 'geo-lookup-start', {
    crnCount: Array.isArray(crns) ? crns.length : 0
  })

  const enriched = await Promise.all(
    crns.map(async (crn) => {
      if (crn.city || crn.region || crn.country || crn.country_code) {
        return crn
      }

      try {
        const host = lookupHost(crn.address)
        const ip = await resolveHostIp(host)
        if (!ip) return crn

        const geo = await lookupIpLocation(ip)
        return {
          ...crn,
          ...geo
        }
      } catch {
        return crn
      }
    })
  )

  emitTrace(trace, 'geo-lookup-end', {
    crnCount: Array.isArray(enriched) ? enriched.length : 0,
    geocodedCount: Array.isArray(enriched)
      ? enriched.filter((crn) => Boolean(crn.city || crn.region || crn.country || crn.country_code)).length
      : 0
  })

  return enriched
}

function normalizeCountryCode(value) {
  const normalized = asString(value)?.toUpperCase() ?? null
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : null
}

function compatibleCrns(crns, excludedHashes = []) {
  const excluded = new Set((excludedHashes ?? []).filter(Boolean))
  return [...(crns ?? [])].filter((crn) => {
    if (!crn?.hash || excluded.has(crn.hash)) return false
    if (crn.qemu_support === false) return false
    if (crn.system_usage?.active === false) return false
    return true
  })
}

function scoreSortedCrns(crns) {
  return [...(crns ?? [])].sort((left, right) => {
    const rightScore = typeof right.score === 'number' ? right.score : Number(right.score ?? Number.NEGATIVE_INFINITY)
    const leftScore = typeof left.score === 'number' ? left.score : Number(left.score ?? Number.NEGATIVE_INFINITY)
    if (rightScore !== leftScore) return rightScore - leftScore
    const leftName = (left.name || left.address || left.hash).toLowerCase()
    const rightName = (right.name || right.address || right.hash).toLowerCase()
    return leftName.localeCompare(rightName)
  })
}

export async function listGeocodedCrns(url = CRN_LIST_URL, limit = 30) {
  const sortedCrns = scoreSortedCrns(compatibleCrns(await fetchCrns(url)))
  const geocodedCrns = await enrichCrnsWithGeo(sortedCrns.slice(0, Math.max(1, Number(limit) || 30)))
  return geocodedCrns
    .filter((crn) => Boolean(crn.city || crn.region || crn.country || crn.country_code))
    .sort((left, right) => {
      const leftLabel = `${left.country ?? ''}/${left.region ?? ''}/${left.city ?? ''}/${left.name ?? left.hash}`.toLowerCase()
      const rightLabel = `${right.country ?? ''}/${right.region ?? ''}/${right.city ?? ''}/${right.name ?? right.hash}`.toLowerCase()
      return leftLabel.localeCompare(rightLabel)
    })
}

export async function rankCandidateCrns(crns, options = {}) {
  const preferredCountryCode = normalizeCountryCode(options.preferredCountryCode)
  const geoLimit = Math.max(1, Number(options.geoLimit) || 30)
  const sortedCrns = scoreSortedCrns(compatibleCrns(crns, options.excludedHashes))
  if (!preferredCountryCode || sortedCrns.length === 0) {
    return sortedCrns
  }

  const enrichedTopCrns = await enrichCrnsWithGeo(sortedCrns.slice(0, geoLimit), options.trace ?? null)
  const mergedByHash = new Map(enrichedTopCrns.map((crn) => [crn.hash, crn]))
  const mergedCrns = sortedCrns.map((crn) => mergedByHash.get(crn.hash) ?? crn)
  const originalIndex = new Map(mergedCrns.map((crn, index) => [crn.hash, index]))

  return [...mergedCrns].sort((left, right) => {
    const leftPreferred = normalizeCountryCode(left.country_code) === preferredCountryCode ? 1 : 0
    const rightPreferred = normalizeCountryCode(right.country_code) === preferredCountryCode ? 1 : 0
    if (leftPreferred !== rightPreferred) {
      return rightPreferred - leftPreferred
    }
    return (originalIndex.get(left.hash) ?? Number.MAX_SAFE_INTEGER) - (originalIndex.get(right.hash) ?? Number.MAX_SAFE_INTEGER)
  })
}

export async function selectPreferredCrn(crns, options = {}) {
  return (await rankCandidateCrns(crns, options))[0] ?? null
}

export function signaturePayload(message) {
  return [message.chain, message.sender, message.type, message.item_hash].join('\n')
}

export function defaultRequiredPorts() {
  return [
    { port: 22, tcp: true, udp: false, purpose: 'SSH' },
    { port: 80, tcp: true, udp: false, purpose: 'Temporary setup endpoint' },
    { port: 443, tcp: true, udp: false, purpose: 'Caddy HTTPS and WSS proxy' },
    { port: 9095, tcp: true, udp: true, purpose: 'libp2p raw TCP and UDP transports' }
  ]
}

function normalizeRequestedPort(entry) {
  return {
    port: Number(entry.port),
    tcp: entry.tcp === true,
    udp: entry.udp === true,
    purpose: asString(entry.purpose) ?? undefined
  }
}

function normalizePortFlags(value) {
  if (!value || typeof value !== 'object') return null
  return {
    tcp: value.tcp === true,
    udp: value.udp === true
  }
}

function normalizeExistingEntry(entry) {
  if (!entry?.ports || typeof entry.ports !== 'object') return {}
  return Object.fromEntries(
    Object.entries(entry.ports)
      .map(([port, flags]) => [port, normalizePortFlags(flags)])
      .filter((entry) => entry[1] != null)
  )
}

function requestedPortFlags(portForwards) {
  return Object.fromEntries(
    portForwards.map((entry) => [
      String(entry.port),
      {
        tcp: entry.tcp === true,
        udp: entry.udp === true
      }
    ])
  )
}

function mergePortFlagMaps(existing, requested) {
  const merged = new Map()
  for (const [port, flags] of Object.entries(existing)) {
    merged.set(port, {
      tcp: flags.tcp === true,
      udp: flags.udp === true
    })
  }
  for (const [port, flags] of Object.entries(requested)) {
    const current = merged.get(port)
    merged.set(port, {
      tcp: current?.tcp === true || flags.tcp === true,
      udp: current?.udp === true || flags.udp === true
    })
  }
  return Object.fromEntries([...merged.entries()].sort((left, right) => Number(left[0]) - Number(right[0])))
}

export function mergeRequiredPortForwards(...groups) {
  const merged = new Map()
  for (const group of groups) {
    for (const entry of group ?? []) {
      const normalized = normalizeRequestedPort(entry)
      const current = merged.get(normalized.port)
      merged.set(normalized.port, {
        port: normalized.port,
        tcp: current?.tcp === true || normalized.tcp === true,
        udp: current?.udp === true || normalized.udp === true,
        purpose: current?.purpose ?? normalized.purpose
      })
    }
  }
  return [...merged.values()].sort((left, right) => left.port - right.port)
}

export function createInstanceContent(args) {
  const sshKey = normalizeSshPublicKey(args.sshPublicKey)
  if (!sshKey) {
    throw new Error('An SSH public key is required.')
  }
  if (!isValidSshPublicKey(sshKey)) {
    throw new Error('SSH public key must be a single valid .pub line.')
  }
  if (!args.rootfsItemHash || !/^[a-fA-F0-9]{64}$/.test(args.rootfsItemHash)) {
    throw new Error('rootfsItemHash must be a 64-character Aleph item hash.')
  }

  const content = {
    address: args.address,
    time: args.now ?? Date.now() / 1000,
    allow_amend: false,
    metadata: {
      name: args.name.trim(),
      rootfs_version: args.rootfsVersion ?? 'custom-rootfs',
      deployer: 'universal-connectivity-github-action'
    },
    authorized_keys: [sshKey],
    environment: {
      internet: true,
      aleph_api: true,
      hypervisor: 'qemu',
      reproducible: false,
      shared_cache: false
    },
    resources: {
      vcpus: Number(args.vcpus),
      memory: Number(args.memoryMiB),
      seconds: Number(args.seconds ?? 30)
    },
    payment: {
      type: 'credit'
    },
    requirements: args.crnHash
      ? {
          node: {
            node_hash: args.crnHash
          }
        }
      : undefined,
    volumes: [],
    rootfs: {
      parent: {
        ref: args.rootfsItemHash,
        use_latest: true
      },
      persistence: 'host',
      size_mib: Number(args.rootfsSizeMiB)
    }
  }

  return content
}

export async function createUnsignedInstanceMessage(args) {
  const itemContent = JSON.stringify(args.content)
  return {
    sender: args.sender,
    chain: 'ETH',
    type: 'INSTANCE',
    item_hash: sha256Hex(itemContent),
    item_type: 'inline',
    item_content: itemContent,
    time: args.now ?? Date.now() / 1000,
    channel: args.channel ?? ALEPH_DEFAULT_CHANNEL
  }
}

export async function signInstanceMessage(unsignedMessage, privateKey) {
  const wallet = new Wallet(privateKey)
  const signature = await wallet.signMessage(signaturePayload(unsignedMessage))
  return {
    ...unsignedMessage,
    signature
  }
}

function normalizeMessageStatus(status) {
  if (typeof status !== 'string') return 'unknown'
  const normalized = status.toLowerCase()
  if (normalized === 'processed' || normalized === 'pending' || normalized === 'rejected') {
    return normalized
  }
  return 'unknown'
}

function isInvalidMessageFormatResponse(response, payload) {
  if (response.status !== 422) return false
  const details = payload?.details
  if (typeof details === 'string' && details.includes('InvalidMessageFormat')) return true
  if (details && typeof details === 'object') {
    const detailMessage = details.message
    if (typeof detailMessage === 'string' && detailMessage.includes('InvalidMessageFormat')) return true
  }
  return false
}

async function postBroadcastPayload(body, apiHost, trace = null) {
  const { response, payload } = await fetchJson(`${apiHost}/api/v0/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  }, 30000, 3, trace)
  return { response, payload }
}

export async function broadcastAlephMessage(message, apiHost = ALEPH_API_HOST, sync = false, trace = null) {
  const attempts = [{ sync, message }, { ...message, sync }, { ...message }]

  for (let index = 0; index < attempts.length; index += 1) {
    emitTrace(trace, 'aleph-broadcast-attempt', {
      index: index + 1,
      attempts: attempts.length,
      body: attempts[index]
    })
    const { response, payload } = await postBroadcastPayload(attempts[index], apiHost, trace)
    if (response.ok || response.status === 202) {
      return {
        httpStatus: response.status,
        response: payload ?? {}
      }
    }

    const canRetry = index < attempts.length - 1 && isInvalidMessageFormatResponse(response, payload ?? {})
    if (!canRetry) {
      throw new Error(`Broadcast failed: ${response.status} ${JSON.stringify(payload ?? {})}`)
    }
  }

  throw new Error('Broadcast failed: no compatible request format was accepted')
}

export async function fetchPortForwardAggregate(address, apiHost = ALEPH_API_HOST, trace = null) {
  const requestUrl = new URL(`/api/v0/aggregates/${address}.json`, apiHost)
  requestUrl.searchParams.set('keys', 'port-forwarding')
  const { response, payload } = await fetchJson(requestUrl, {}, 30000, 3, trace)
  if (response.status === 404) return {}
  if (!response.ok) {
    throw new Error(`Port-forward aggregate request failed: ${response.status}`)
  }
  const aggregate = payload?.data?.['port-forwarding']
  if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) return {}
  return aggregate
}

async function createUnsignedAggregateMessage(args) {
  const itemContent = JSON.stringify(args.content)
  return {
    sender: args.sender,
    chain: 'ETH',
    type: 'AGGREGATE',
    item_hash: sha256Hex(itemContent),
    item_type: 'inline',
    item_content: itemContent,
    time: args.now ?? Date.now() / 1000,
    channel: args.channel ?? ALEPH_DEFAULT_CHANNEL
  }
}

async function createUnsignedForgetMessage(args) {
  const content = {
    address: args.sender,
    time: args.now ?? Date.now() / 1000,
    hashes: [...new Set((args.hashes ?? []).filter(Boolean))],
    aggregates: [...new Set((args.aggregates ?? []).filter(Boolean))],
    reason: asString(args.reason) ?? undefined
  }

  if (content.hashes.length === 0 && content.aggregates.length === 0) {
    throw new Error('FORGET message requires at least one hash or aggregate key.')
  }

  const itemContent = JSON.stringify(content)
  return {
    sender: args.sender,
    chain: 'ETH',
    type: 'FORGET',
    item_hash: sha256Hex(itemContent),
    item_type: 'inline',
    item_content: itemContent,
    time: args.now ?? Date.now() / 1000,
    channel: args.channel ?? ALEPH_DEFAULT_CHANNEL
  }
}

export async function ensureInstancePortForwards(args) {
  const requestedPorts = mergeRequiredPortForwards(args.requiredPorts ?? defaultRequiredPorts())
  const aggregate = await fetchPortForwardAggregate(args.sender, args.apiHost ?? ALEPH_API_HOST, args.trace)
  const existingPorts = normalizeExistingEntry(aggregate[args.instanceItemHash])
  const mergedPorts = mergePortFlagMaps(existingPorts, requestedPortFlags(requestedPorts))
  const content = {
    address: args.sender,
    key: 'port-forwarding',
    content: {
      [args.instanceItemHash]: {
        ports: mergedPorts
      }
    },
    time: Date.now() / 1000
  }

  const unsignedMessage = await createUnsignedAggregateMessage({
    sender: args.sender,
    content,
    channel: args.channel
  })
  const message = await signInstanceMessage(unsignedMessage, args.privateKey)
  const { response, httpStatus } = await broadcastAlephMessage(message, args.apiHost ?? ALEPH_API_HOST, false, args.trace)
  const aggregateStatus = normalizeMessageStatus(response?.message_status ?? (httpStatus === 202 ? 'pending' : undefined))

  if (aggregateStatus === 'rejected') {
    throw new Error(`Port-forward aggregate was rejected by Aleph: ${JSON.stringify(response?.details ?? response)}`)
  }

  return {
    aggregateItemHash: message.item_hash,
    aggregateStatus,
    requestedPorts
  }
}

export async function forgetAlephMessages(args) {
  const wallet = new Wallet(args.privateKey)
  const sender = args.sender ?? wallet.address
  const unsignedMessage = await createUnsignedForgetMessage({
    sender,
    hashes: args.hashes,
    aggregates: args.aggregates,
    reason: args.reason,
    channel: args.channel,
    now: args.now
  })
  const message = await signInstanceMessage(unsignedMessage, args.privateKey)
  const result = await broadcastAlephMessage(message, args.apiHost ?? ALEPH_API_HOST, false, args.trace)

  return {
    sender,
    itemHash: message.item_hash,
    response: result.response,
    httpStatus: result.httpStatus,
    status: normalizeMessageStatus(result.response?.message_status ?? (result.httpStatus === 202 ? 'pending' : undefined))
  }
}

async function cleanupFailedDeployment(args) {
  try {
    return await forgetAlephMessages({
      privateKey: args.privateKey,
      sender: args.sender,
      hashes: [args.instanceItemHash],
      reason: args.reason ?? 'Discard failed deployment attempt',
      channel: args.channel,
      apiHost: args.apiHost
    })
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function deployVm(args) {
  const crns = args.crns ?? (await fetchCrns(args.crnListUrl ?? CRN_LIST_URL, args.trace))
  const selectedCrn =
    args.selectedCrn ??
    (args.crnHash
      ? findCrnByHash(crns, args.crnHash)
      : await selectPreferredCrn(crns, {
          excludedHashes: args.excludedCrnHashes,
          preferredCountryCode: args.preferredCountryCode,
          geoLimit: args.geoCrnLimit,
          trace: args.trace
        }))
  if (!selectedCrn) {
    throw new Error('No compatible CRN was available for deployment.')
  }
  const wallet = new Wallet(args.privateKey)
  const sender = args.sender ?? wallet.address
  const content = createInstanceContent({
    ...args,
    address: sender,
    crnHash: selectedCrn.hash
  })
  const unsignedMessage = await createUnsignedInstanceMessage({
    sender,
    content,
    channel: args.channel ?? ALEPH_DEFAULT_CHANNEL,
    now: args.now
  })
  const signedMessage = await signInstanceMessage(unsignedMessage, args.privateKey)
  const result = await broadcastAlephMessage(signedMessage, args.apiHost ?? ALEPH_API_HOST, false, args.trace)

  return {
    sender,
    selectedCrn,
    itemHash: signedMessage.item_hash,
    content,
    message: signedMessage,
    response: result.response,
    httpStatus: result.httpStatus,
    status: normalizeMessageStatus(result.response?.message_status ?? (result.httpStatus === 202 ? 'pending' : undefined))
  }
}

export async function fetchMessageEnvelope(itemHash, apiHost = ALEPH_API_HOST, trace = null) {
  const { response, payload } = await fetchJson(`${apiHost}/api/v0/messages/${itemHash}`, {}, 30000, 3, trace)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Message lookup failed: ${response.status}`)
  }
  return payload
}

function insufficientBalanceMessage(details) {
  const firstError = Array.isArray(details?.errors) ? details.errors[0] : null
  const accountBalance = firstError?.account_balance
  const requiredBalance = firstError?.required_balance
  if (accountBalance != null && requiredBalance != null) {
    return `insufficient Aleph balance: account has ${accountBalance}, required is ${requiredBalance}`
  }
  return null
}

export async function inspectMessageResult(itemHash, apiHost = ALEPH_API_HOST, label = 'Message', trace = null) {
  const payload = await fetchMessageEnvelope(itemHash, apiHost, trace)
  if (!payload) {
    return {
      status: 'unknown',
      errorCode: null,
      details: null,
      rejectionReason: `${label} ${itemHash} was not found on Aleph.`
    }
  }

  const status = normalizeMessageStatus(payload.status)
  const errorCode = typeof payload.error_code === 'number' ? payload.error_code : null
  const details = payload.details && typeof payload.details === 'object' ? payload.details : null
  let rejectionReason = null

  if (status === 'rejected') {
    const balanceMessage = errorCode === 5 ? insufficientBalanceMessage(details) : null
    rejectionReason = balanceMessage
      ? `${label} ${itemHash} was rejected by Aleph due to ${balanceMessage}.`
      : `${label} ${itemHash} was rejected by Aleph${errorCode ? ` (error ${errorCode})` : ''}.`
  }

  return {
    status,
    errorCode,
    details,
    rejectionReason
  }
}

export async function inspectDeploymentResult(itemHash, rootfsRef, apiHost = ALEPH_API_HOST, trace = null) {
  const inspected = await inspectMessageResult(itemHash, apiHost, 'Deployment message', trace)
  const { status, errorCode, details } = inspected
  let rejectionReason = null

  if (status === 'rejected') {
    if (rootfsRef && Array.isArray(details?.errors) && details.errors.includes(rootfsRef)) {
      rejectionReason =
        `Aleph rejected this deployment because the referenced rootfs STORE message ${rootfsRef} is not ready.`
    } else {
      rejectionReason = `Aleph rejected this deployment${errorCode ? ` (error ${errorCode})` : ''}.`
    }
  }

  return {
    status,
    errorCode,
    details,
    rejectionReason
  }
}

export async function waitForDeploymentResult(itemHash, rootfsRef, apiHost = ALEPH_API_HOST, attempts = 15, delayMs = 2000, trace = null) {
  let lastResult = await inspectDeploymentResult(itemHash, rootfsRef, apiHost, trace)
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (lastResult.status === 'processed' || lastResult.status === 'rejected') {
      return lastResult
    }
    await sleep(delayMs)
    lastResult = await inspectDeploymentResult(itemHash, rootfsRef, apiHost, trace)
  }
  return lastResult
}

async function waitForRequiredMessage(itemHash, options = {}) {
  const label = options.label ?? 'Message'
  const apiHost = options.apiHost ?? ALEPH_API_HOST
  const attempts = Math.max(1, Number(options.attempts ?? 60))
  const delayMs = Math.max(250, Number(options.delayMs ?? 5000))

  let lastResult = await inspectMessageResult(itemHash, apiHost, label, options.trace ?? null)
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (lastResult.status === 'processed' || lastResult.status === 'rejected') {
      break
    }
    await sleep(delayMs)
    lastResult = await inspectMessageResult(itemHash, apiHost, label, options.trace ?? null)
  }

  if (lastResult.status === 'processed') {
    return lastResult
  }
  if (lastResult.status === 'rejected') {
    throw new Error(lastResult.rejectionReason ?? `${label} ${itemHash} was rejected by Aleph.`)
  }
  throw new Error(`${label} ${itemHash} stayed ${lastResult.status} after waiting ${attempts} attempts with ${delayMs}ms delay.`)
}

async function fetchSchedulerAllocation(itemHash, trace = null) {
  const { response, payload } = await fetchJson(`${SCHEDULER_ALLOCATION_URL}/${itemHash}`, {}, 30000, 3, trace)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Scheduler allocation request failed: ${response.status}`)
  }

  const node = payload?.node
  return {
    source: 'scheduler',
    crnHash: asString(node?.node_id),
    crnUrl: asString(node?.url),
    node: node
      ? {
          node_id: asString(node.node_id) ?? undefined,
          url: asString(node.url) ?? undefined,
          ipv6: asString(node.ipv6),
          supports_ipv6: typeof node.supports_ipv6 === 'boolean' ? node.supports_ipv6 : undefined
        }
      : null,
    vmIpv6: asString(payload?.vm_ipv6),
    period: payload?.period
      ? {
          start_timestamp: asString(payload.period.start_timestamp) ?? undefined,
          duration_seconds: asNumber(payload.period.duration_seconds) ?? undefined
        }
      : null
  }
}

async function fetch2n6WebAccessUrl(instanceItemHash, trace = null) {
  const { response, payload } = await fetchJson(`${TWO_N_SIX_HASH_URL}/${instanceItemHash}`, {}, 30000, 3, trace)
  if (!response.ok) return null
  return {
    url: normalizeProxyUrl(payload?.url ?? payload?.subdomain),
    active: typeof payload?.active === 'boolean' ? payload.active : null,
    subdomain: asString(payload?.subdomain)
  }
}

async function fetchCrnExecutionMap(crnUrl, trace = null) {
  const normalizedCrnUrl = String(crnUrl).replace(/\/+$/, '')
  for (const [version, suffix] of [
    ['v2', '/v2/about/executions/list'],
    ['v1', '/about/executions/list']
  ]) {
    const { response, payload } = await fetchJson(`${normalizedCrnUrl}${suffix}`, {}, 30000, 3, trace)
    if (response.ok) {
      return {
        version,
        payload: payload && typeof payload === 'object' ? payload : null,
        requestUrl: `${normalizedCrnUrl}${suffix}`
      }
    }
    if (response.status !== 404) {
      return {
        version,
        payload: null,
        requestUrl: `${normalizedCrnUrl}${suffix}`
      }
    }
  }

  return {
    version: 'v2',
    payload: null,
    requestUrl: `${normalizedCrnUrl}/v2/about/executions/list`
  }
}

async function notifyCrnAllocation(crnUrl, itemHash, trace = null) {
  const normalizedCrnUrl = asString(crnUrl)?.replace(/\/+$/, '')
  if (!normalizedCrnUrl) {
    return {
      status: 'skipped',
      reason: 'No CRN URL available for allocation notification.'
    }
  }

  try {
    const { response, payload } = await fetchJson(
      `${normalizedCrnUrl}/control/allocation/notify`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ instance: itemHash })
      },
      30000,
      3,
      trace
    )

    if (!response.ok) {
      return {
        status: 'unconfirmed',
        reason: `CRN allocation notify returned ${response.status}.`,
        payload
      }
    }

    return {
      status: 'confirmed',
      payload
    }
  } catch (error) {
    return {
      status: 'unconfirmed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

function extractProxyUrl(item, networking) {
  const candidates = [
    networking?.proxy_url,
    networking?.proxyUrl,
    networking?.web_access_url,
    networking?.webAccessUrl,
    networking?.proxy_hostname,
    networking?.proxyHostname,
    networking?.domain,
    networking?.hostname,
    item?.web_access?.url,
    item?.web_access?.proxy_url,
    item?.web_access?.hostname,
    item?.web_access?.domain,
    item?.webAccess?.url,
    item?.webAccess?.proxy_url,
    item?.webAccess?.hostname,
    item?.webAccess?.domain
  ]

  for (const candidate of candidates) {
    const normalized = normalizeProxyUrl(candidate)
    if (normalized) return normalized
  }

  return null
}

function normalizeExecution(item, crnUrl) {
  const networking = item?.networking ?? null
  const mappedPorts =
    networking && networking.mapped_ports && typeof networking.mapped_ports === 'object'
      ? Object.fromEntries(
          Object.entries(networking.mapped_ports).map(([port, mapping]) => [
            port,
            {
              host: asNumber(mapping?.host) ?? undefined,
              tcp: typeof mapping?.tcp === 'boolean' ? mapping.tcp : undefined,
              udp: typeof mapping?.udp === 'boolean' ? mapping.udp : undefined
            }
          ])
        )
      : undefined

  if (networking && ('host_ipv4' in networking || 'ipv6_ip' in networking || 'ipv4_network' in networking)) {
    return {
      crnUrl,
      version: 'v2',
      running: typeof item?.running === 'boolean' ? item.running : undefined,
      networking: {
        ipv4_network: asString(networking.ipv4_network),
        host_ipv4: asString(networking.host_ipv4),
        ipv6_network: asString(networking.ipv6_network),
        ipv6_ip: asString(networking.ipv6_ip),
        ipv4_ip: asString(networking.ipv4_ip),
        proxy_url: extractProxyUrl(item, networking),
        mapped_ports: mappedPorts
      },
      status: item?.status && typeof item.status === 'object' ? item.status : null
    }
  }

  return {
    crnUrl,
    version: 'v1',
    networking: {
      ipv4: asString(networking?.ipv4),
      ipv6: asString(networking?.ipv6),
      mapped_ports: mappedPorts
    },
    status: null
  }
}

function findCrnByHash(crns, crnHash) {
  return crns.find((crn) => crn.hash === crnHash) ?? null
}

function describeRuntimeAvailability(runtime) {
  const execution = runtime?.execution ?? null
  const mappedPorts = runtime?.mappedPorts ?? {}
  const hostIpv4 = runtime?.hostIpv4 ?? null
  const proxyUrl = runtime?.proxyUrl ?? null
  const schedulerSource = runtime?.allocation?.source ?? null
  const webAccessActive = runtime?.webAccess?.active ?? null
  const mappedPortCount = Object.keys(mappedPorts).length

  if (hostIpv4 && mappedPortCount > 0) {
    return {
      state: 'ready',
      reason: null,
      schedulerSource,
      executionSeen: Boolean(execution),
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (!execution && proxyUrl && webAccessActive === false) {
    return {
      state: 'proxy-reserved-inactive',
      reason:
        'Aleph reserved a proxy URL for the VM, but it is still inactive and the selected CRN has not exposed execution networking yet.',
      schedulerSource,
      executionSeen: false,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (!execution && schedulerSource === 'manual') {
    return {
      state: 'crn-execution-missing',
      reason:
        'The deployment is pinned to a specific CRN, but that CRN is not exposing this VM in its execution list yet.',
      schedulerSource,
      executionSeen: false,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (execution && !hostIpv4) {
    return {
      state: 'execution-missing-host-ipv4',
      reason: 'The CRN exposed an execution record, but it does not include a public host IPv4 yet.',
      schedulerSource,
      executionSeen: true,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (execution && mappedPortCount === 0) {
    return {
      state: 'execution-missing-port-mappings',
      reason: 'The CRN exposed an execution record, but mapped ports are still empty.',
      schedulerSource,
      executionSeen: true,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  return {
    state: 'runtime-pending',
    reason: 'Aleph has not exposed enough runtime networking details yet.',
    schedulerSource,
    executionSeen: Boolean(execution),
    webAccessActive,
    mappedPortCount,
    proxyUrl
  }
}

export async function fetchVmRuntime(args) {
  const crns = args.crns ?? (await fetchCrns(args.crnListUrl ?? CRN_LIST_URL, args.trace))
  const schedulerAllocation = await fetchSchedulerAllocation(args.itemHash, args.trace).catch(() => null)
  const selectedCrn = args.crnHash ? findCrnByHash(crns, args.crnHash) : null
  const allocation =
    schedulerAllocation ??
    (selectedCrn
      ? {
          source: 'manual',
          crnHash: selectedCrn.hash,
          crnUrl: selectedCrn.address,
          node: { url: selectedCrn.address },
          vmIpv6: null,
          period: null
        }
      : null)

  const webAccess = await fetch2n6WebAccessUrl(args.itemHash, args.trace).catch(() => null)
  const webAccessUrl = webAccess?.url ?? null
  let execution = null

  if (allocation?.crnUrl) {
    const executionLookup = await fetchCrnExecutionMap(allocation.crnUrl, args.trace)
    const executionPayload = executionLookup.payload?.[args.itemHash]
    if (executionPayload) {
      execution = normalizeExecution(executionPayload, allocation.crnUrl)
      if (!execution.networking.proxy_url && webAccessUrl) {
        execution.networking.proxy_url = webAccessUrl
      }
    }
  }

  const hostIpv4 = execution?.networking?.host_ipv4 ?? execution?.networking?.ipv4 ?? null
  const ipv6 = execution?.networking?.ipv6_ip ?? execution?.networking?.ipv6 ?? allocation?.vmIpv6 ?? null
  const sshPort = execution?.networking?.mapped_ports?.['22']?.host ?? null
  const proxyUrl = execution?.networking?.proxy_url ?? webAccessUrl ?? null

  emitTrace(args.trace ?? null, 'vm-runtime-snapshot', {
    itemHash: args.itemHash,
    allocation,
    execution,
    webAccess,
    hostIpv4,
    ipv6,
    proxyUrl,
    mappedPorts: execution?.networking?.mapped_ports ?? {}
  })

  const diagnostics = describeRuntimeAvailability({
    allocation,
    execution,
    webAccess,
    hostIpv4,
    ipv6,
    proxyUrl,
    mappedPorts: execution?.networking?.mapped_ports ?? {}
  })

  return {
    allocation,
    execution,
    webAccess,
    webAccessUrl,
    hostIpv4,
    ipv6,
    proxyUrl,
    mappedPorts: execution?.networking?.mapped_ports ?? {},
    diagnostics,
    sshCommand: hostIpv4 && sshPort ? `ssh root@${hostIpv4} -p ${sshPort}` : ipv6 ? `ssh root@${ipv6}` : null,
    selectedCrn
  }
}

export async function waitForVmRuntime(args) {
  let lastRuntime = null
  const attempts = Number(args.attempts ?? 20)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastRuntime = await fetchVmRuntime(args)
    const mappedPorts = lastRuntime?.mappedPorts ?? {}
    if (lastRuntime?.hostIpv4 && Object.keys(mappedPorts).length > 0) {
      return lastRuntime
    }
    if (attempt === 0 || attempt === attempts - 1 || (attempt + 1) % 5 === 0) {
      emitTrace(args.trace ?? null, 'vm-runtime-wait', {
        itemHash: args.itemHash,
        attempt: attempt + 1,
        attempts,
        state: lastRuntime?.diagnostics?.state ?? 'runtime-pending',
        reason: lastRuntime?.diagnostics?.reason ?? null,
        hostIpv4: lastRuntime?.hostIpv4 ?? null,
        mappedPortCount: Object.keys(mappedPorts).length,
        proxyUrl: lastRuntime?.proxyUrl ?? null,
        webAccessActive: lastRuntime?.webAccess?.active ?? null
      })
    }
    await sleep(Number(args.delayMs ?? 4000))
  }
  if (lastRuntime?.diagnostics) {
    lastRuntime.diagnostics.timedOut = true
  }
  return lastRuntime
}

async function tcpProbe(host, port, timeoutMs = 5000) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) })
    const finalize = (result) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finalize({ ok: true }))
    socket.once('timeout', () => finalize({ ok: false, error: `timeout after ${timeoutMs}ms` }))
    socket.once('error', (error) => finalize({ ok: false, error: error.message }))
  })
}

async function httpProbe(url, timeoutMs = 10000) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal
    })
    clearTimeout(timeout)
    return {
      ok: response.ok,
      status: response.status,
      url: response.url
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function proxyHostnameFromUrl(value) {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

function createDeploymentError(message, partialResult = null) {
  const error = new Error(message)
  if (partialResult) {
    error.partialResult = partialResult
  }
  return error
}

export async function configureUcGoPeer(args) {
  if (!args.hostIpv4) {
    throw new Error('Missing host IPv4 for uc-go-peer configuration.')
  }
  if (!args.setupPort) {
    throw new Error('Missing mapped setup port for uc-go-peer configuration.')
  }

  const payload = {
    public_ipv4: args.hostIpv4,
    public_ipv6: args.publicIpv6 ?? undefined,
    proxy_url: args.proxyUrl ?? undefined,
    tcp_port: args.tcpPort ?? undefined,
    ws_port: args.wsPort ?? undefined,
    udp_port: args.udpPort ?? undefined,
    quic_port: args.quicPort ?? undefined,
    webrtc_port: args.webrtcPort ?? undefined
  }

  const { response, payload: responsePayload } = await fetchJson(
    `http://${args.hostIpv4}:${args.setupPort}/configure`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    },
    Number(args.timeoutMs ?? 30000)
  )

  if (!response.ok) {
    throw new Error(
      `Relay setup request failed: ${response.status} ${typeof responsePayload === 'string' ? responsePayload : JSON.stringify(responsePayload ?? {})}`
    )
  }

  return responsePayload
}

export async function verifyUcGoPeerReachability(args) {
  const checks = {}
  const mappedPorts = args.mappedPorts ?? {}
  const hostIpv4 = args.hostIpv4
  const skippedInternalPorts = new Set((args.skipInternalPorts ?? ['80']).map((value) => String(value)))

  if (hostIpv4) {
    for (const [internalPort, mapping] of Object.entries(mappedPorts)) {
      if (skippedInternalPorts.has(String(internalPort))) {
        continue
      }
      if (mapping?.tcp === true && mapping?.host) {
        checks[`tcp:${internalPort}`] = {
          host: hostIpv4,
          port: mapping.host,
          ...(await tcpProbe(hostIpv4, mapping.host, Number(args.tcpTimeoutMs ?? 5000)))
        }
      } else if (mapping?.udp === true && mapping?.host) {
        checks[`udp:${internalPort}`] = {
          host: hostIpv4,
          port: mapping.host,
          ok: null,
          note: 'UDP mapping published; CI does not perform an application-level UDP handshake probe.'
        }
      }
    }
  }

  if (args.proxyUrl) {
    checks['https:proxy'] = await httpProbe(args.proxyUrl, Number(args.httpTimeoutMs ?? 10000))
  }
  const proxyHostname = args.proxyHostname ?? (args.proxyUrl ? proxyHostnameFromUrl(args.proxyUrl) : null)
  if (proxyHostname) {
    checks['tcp:proxy-443'] = await tcpProbe(proxyHostname, 443, Number(args.tcpTimeoutMs ?? 5000))
  }

  const failedChecks = Object.entries(checks).filter(([, value]) => value?.ok === false)
  return {
    ok: failedChecks.length === 0,
    checks
  }
}

export async function deployVmAndWait(args) {
  const log = typeof args.log === 'function' ? args.log : () => {}
  const trace = { log, label: 'aleph-vm' }

  log('notice', `Waiting for rootfs STORE message ${args.rootfsItemHash} to become processed before VM deployment.`)
  await waitForRequiredMessage(args.rootfsItemHash, {
    label: 'Rootfs STORE message',
    apiHost: args.apiHost ?? ALEPH_API_HOST,
    attempts: Number(args.rootfsWaitAttempts ?? args.waitAttempts ?? 60),
    delayMs: Number(args.rootfsWaitDelayMs ?? args.waitDelayMs ?? 5000),
    trace
  })

  const crns = args.crns ?? (await fetchCrns(args.crnListUrl ?? CRN_LIST_URL, trace))
  const candidateCrns =
    args.crnHash && findCrnByHash(crns, args.crnHash)
      ? [findCrnByHash(crns, args.crnHash)]
      : await rankCandidateCrns(crns, {
          preferredCountryCode: args.preferredCountryCode,
          geoLimit: args.geoCrnLimit,
          excludedHashes: args.excludedCrnHashes,
          trace
        })

  const maxCrnAttempts = Math.max(1, Number(args.maxCrnAttempts ?? 5))
  const attemptedCrns = []
  let deployment = null
  let deploymentResult = null
  let lastRejection = null
  let lastPartialResult = null

  for (const candidateCrn of candidateCrns.slice(0, maxCrnAttempts)) {
    attemptedCrns.push(candidateCrn)
    log(
      'notice',
      `Trying CRN ${attemptedCrns.length}/${Math.min(candidateCrns.length, maxCrnAttempts)}: ${candidateCrn.name ?? candidateCrn.hash} (${candidateCrn.hash}).`
    )
    deployment = await deployVm({
      ...args,
      crns,
      selectedCrn: candidateCrn,
      crnHash: candidateCrn.hash,
      trace
    })
    deploymentResult = await waitForDeploymentResult(
      deployment.itemHash,
      args.rootfsItemHash,
      args.apiHost ?? ALEPH_API_HOST,
      Number(args.waitAttempts ?? 60),
      Number(args.waitDelayMs ?? 5000),
      trace
    )

    if (deploymentResult.status === 'processed') {
      log('notice', `Deployment message ${deployment.itemHash} was processed on ${candidateCrn.name ?? candidateCrn.hash}.`)
    } else if (deploymentResult.status === 'rejected') {
      log(
        'warning',
        `Deployment on ${candidateCrn.name ?? candidateCrn.hash} was rejected: ${deploymentResult.rejectionReason ?? 'no additional rejection reason from Aleph'}.`
      )
      lastRejection = {
        candidateCrn,
        deployment,
        deploymentResult
      }
      lastPartialResult = {
        ...deployment,
        attemptedCrns,
        deploymentResult,
        runtime: null,
        configuration: null,
        verification: null,
        portForwarding: null
      }
      deployment = null
      deploymentResult = null
      continue
    } else {
      throw new Error(
        `Deployment message ${deployment.itemHash} on CRN ${candidateCrn.name ?? candidateCrn.hash} stayed ${deploymentResult.status} without becoming processed.`
      )
    }

    const portForwarding = await ensureInstancePortForwards({
      sender: deployment.sender,
      instanceItemHash: deployment.itemHash,
      requiredPorts: args.requiredPorts ?? defaultRequiredPorts(),
      privateKey: args.privateKey,
      channel: args.channel,
      apiHost: args.apiHost ?? ALEPH_API_HOST,
      trace
    })

    const crnNotify = await notifyCrnAllocation(
      deployment.selectedCrn?.address ?? deployment.selectedCrn?.url ?? candidateCrn.address ?? null,
      deployment.itemHash,
      trace
    )
    if (crnNotify.status === 'confirmed') {
      log('notice', `CRN allocation notify acknowledged for deployment ${deployment.itemHash}.`)
    } else if (crnNotify.status === 'unconfirmed') {
      log(
        'warning',
        `CRN allocation notify for deployment ${deployment.itemHash} could not be confirmed.${crnNotify.reason ? ` ${crnNotify.reason}` : ''}`
      )
    }

    const runtime = await waitForVmRuntime({
      itemHash: deployment.itemHash,
      crnHash: deployment.selectedCrn?.hash ?? args.crnHash,
      crnListUrl: args.crnListUrl,
      attempts: args.runtimeAttempts ?? args.waitAttempts ?? 40,
      delayMs: args.runtimeDelayMs ?? args.waitDelayMs ?? 5000,
      trace
    })

    if (!runtime?.hostIpv4 || Object.keys(runtime?.mappedPorts ?? {}).length === 0) {
      emitTrace(trace, 'runtime-missing-networking', {
        itemHash: deployment.itemHash,
        crn: candidateCrn,
        runtime
      })
      log(
        'warning',
        `Deployment ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash} was processed but did not expose runtime networking in time.${runtime?.diagnostics?.reason ? ` ${runtime.diagnostics.reason}` : ''}${runtime?.proxyUrl ? ` Proxy URL: ${runtime.proxyUrl}.` : ''}`
      )
      const cleanup = await cleanupFailedDeployment({
        privateKey: args.privateKey,
        sender: deployment.sender,
        instanceItemHash: deployment.itemHash,
        reason: `Processed deployment never exposed runtime networking${runtime?.diagnostics?.state ? ` (${runtime.diagnostics.state})` : ''}`,
        channel: args.channel,
        apiHost: args.apiHost ?? ALEPH_API_HOST,
        trace
      })
      if (cleanup?.error) {
        log(
          'warning',
          `Cleanup failed for deployment ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash}: ${cleanup.error}`
        )
      } else if (cleanup?.itemHash) {
        log(
          'notice',
          `Cleanup forget message ${cleanup.itemHash} submitted for failed deployment ${deployment.itemHash}.`
        )
      }
      lastPartialResult = {
        ...deployment,
        attemptedCrns,
        deploymentResult,
        runtime,
        configuration: null,
        verification: null,
        portForwarding,
        crnNotify,
        cleanup
      }
      deployment = null
      deploymentResult = null
      continue
    }

    let configuration = null
    let verification = null

    if (runtime && args.autoConfigure !== false) {
      const mappedPorts = runtime.mappedPorts ?? {}
      const setupPort = mappedPorts['80']?.host ?? null
      const tcpPort = mappedPorts['9095']?.host ?? null
      const wsPort = mappedPorts['443']?.host ?? 443
      const udpPort = mappedPorts['9095']?.udp === true ? mappedPorts['9095']?.host ?? null : null
      const setupUrl = runtime.hostIpv4 && setupPort ? `http://${runtime.hostIpv4}:${setupPort}/health` : null

      let setupHealth = null
      if (setupUrl) {
        for (let attempt = 0; attempt < Number(args.setupAttempts ?? 15); attempt += 1) {
          setupHealth = await httpProbe(setupUrl, Number(args.httpTimeoutMs ?? 10000))
          if (setupHealth.ok) {
            break
          }
          await sleep(Number(args.setupDelayMs ?? 4000))
        }
        if (!setupHealth?.ok) {
          throw new Error(`Temporary setup endpoint did not become reachable at ${setupUrl}.`)
        }
      }

      configuration = await configureUcGoPeer({
        hostIpv4: runtime.hostIpv4,
        publicIpv6: runtime.ipv6,
        setupPort,
        tcpPort,
        wsPort,
        udpPort,
        quicPort: udpPort,
        webrtcPort: udpPort,
        proxyUrl: runtime.proxyUrl
      })

      if (args.verifyReachability !== false) {
        let latestVerification = null
        for (let attempt = 0; attempt < Number(args.verifyAttempts ?? 25); attempt += 1) {
          latestVerification = await verifyUcGoPeerReachability({
            hostIpv4: runtime.hostIpv4,
            mappedPorts,
            proxyUrl: runtime.proxyUrl,
            tcpTimeoutMs: args.tcpTimeoutMs,
            httpTimeoutMs: args.httpTimeoutMs
          })
          if (latestVerification.ok) {
            verification = latestVerification
            break
          }
          await sleep(Number(args.verifyDelayMs ?? 5000))
        }
        verification = verification ?? latestVerification
      }

      runtime.setupHealth = setupHealth
    }

    log(
      'notice',
      `Deployment ${deployment.itemHash} is reachable on host IPv4 ${runtime.hostIpv4}.${runtime.proxyUrl ? ` Proxy URL: ${runtime.proxyUrl}.` : ''}`
    )
    return {
      ...deployment,
      attemptedCrns,
      portForwarding,
      deploymentResult,
      runtime,
      configuration,
      verification
    }
  }

  const rejectionSummary =
    lastRejection?.deploymentResult?.rejectionReason ??
    (lastPartialResult
      ? 'A processed VM never exposed runtime networking details on any attempted CRN.'
      : lastRejection
        ? `Aleph rejected the last deployment attempt on ${lastRejection.candidateCrn?.name ?? lastRejection.candidateCrn?.hash}.`
        : 'No compatible CRN deployment attempt succeeded.')
  throw createDeploymentError(`${rejectionSummary} Tried ${attemptedCrns.map((crn) => crn.name ?? crn.hash).join(', ')}.`, lastPartialResult)
}
