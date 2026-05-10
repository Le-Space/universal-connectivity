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

async function fetchJsonOnce(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)

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

    return { response, payload }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson(url, init = {}, timeoutMs = 30000, attempts = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(url, init, timeoutMs)
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

export async function fetchCrns(url = CRN_LIST_URL) {
  const requestUrl = new URL(url)
  requestUrl.searchParams.set('filter_inactive', 'true')
  const { response, payload } = await fetchJson(requestUrl)
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

export async function enrichCrnsWithGeo(crns) {
  return Promise.all(
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
}

export async function listGeocodedCrns(url = CRN_LIST_URL) {
  const crns = await enrichCrnsWithGeo(await fetchCrns(url))
  return crns
    .filter((crn) => Boolean(crn.city || crn.region || crn.country || crn.country_code))
    .sort((left, right) => {
      const leftLabel = `${left.country ?? ''}/${left.region ?? ''}/${left.city ?? ''}/${left.name ?? left.hash}`.toLowerCase()
      const rightLabel = `${right.country ?? ''}/${right.region ?? ''}/${right.city ?? ''}/${right.name ?? right.hash}`.toLowerCase()
      return leftLabel.localeCompare(rightLabel)
    })
}

export function selectPreferredCrn(crns) {
  return [...(crns ?? [])]
    .filter((crn) => {
      if (crn.qemu_support === false) return false
      if (crn.system_usage?.active === false) return false
      return true
    })
    .sort((left, right) => {
      const rightScore = typeof right.score === 'number' ? right.score : Number(right.score ?? Number.NEGATIVE_INFINITY)
      const leftScore = typeof left.score === 'number' ? left.score : Number(left.score ?? Number.NEGATIVE_INFINITY)
      if (rightScore !== leftScore) return rightScore - leftScore
      const leftName = (left.name || left.address || left.hash).toLowerCase()
      const rightName = (right.name || right.address || right.hash).toLowerCase()
      return leftName.localeCompare(rightName)
    })[0] ?? null
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

async function postBroadcastPayload(body, apiHost) {
  const { response, payload } = await fetchJson(`${apiHost}/api/v0/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return { response, payload }
}

export async function broadcastAlephMessage(message, apiHost = ALEPH_API_HOST, sync = false) {
  const attempts = [{ sync, message }, { ...message, sync }, { ...message }]

  for (let index = 0; index < attempts.length; index += 1) {
    const { response, payload } = await postBroadcastPayload(attempts[index], apiHost)
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

export async function fetchPortForwardAggregate(address, apiHost = ALEPH_API_HOST) {
  const requestUrl = new URL(`/api/v0/aggregates/${address}.json`, apiHost)
  requestUrl.searchParams.set('keys', 'port-forwarding')
  const { response, payload } = await fetchJson(requestUrl)
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

export async function ensureInstancePortForwards(args) {
  const requestedPorts = mergeRequiredPortForwards(args.requiredPorts ?? defaultRequiredPorts())
  const aggregate = await fetchPortForwardAggregate(args.sender, args.apiHost ?? ALEPH_API_HOST)
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
  const { response, httpStatus } = await broadcastAlephMessage(message, args.apiHost ?? ALEPH_API_HOST, false)
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

export async function deployVm(args) {
  const crns = args.crns ?? (await fetchCrns(args.crnListUrl ?? CRN_LIST_URL))
  const selectedCrn = args.crnHash ? findCrnByHash(crns, args.crnHash) : selectPreferredCrn(crns)
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
  const result = await broadcastAlephMessage(signedMessage, args.apiHost ?? ALEPH_API_HOST, false)

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

export async function fetchMessageEnvelope(itemHash, apiHost = ALEPH_API_HOST) {
  const { response, payload } = await fetchJson(`${apiHost}/api/v0/messages/${itemHash}`)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Message lookup failed: ${response.status}`)
  }
  return payload
}

export async function inspectDeploymentResult(itemHash, rootfsRef, apiHost = ALEPH_API_HOST) {
  const payload = await fetchMessageEnvelope(itemHash, apiHost)
  if (!payload) {
    return {
      status: 'unknown',
      errorCode: null,
      details: null,
      rejectionReason: `Deployment message ${itemHash} was not found on Aleph.`
    }
  }

  const status = normalizeMessageStatus(payload.status)
  const errorCode = typeof payload.error_code === 'number' ? payload.error_code : null
  const details = payload.details && typeof payload.details === 'object' ? payload.details : null
  let rejectionReason = null

  if (status === 'rejected') {
    if (rootfsRef && Array.isArray(payload.details?.errors) && payload.details.errors.includes(rootfsRef)) {
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

export async function waitForDeploymentResult(itemHash, rootfsRef, apiHost = ALEPH_API_HOST, attempts = 15, delayMs = 2000) {
  let lastResult = await inspectDeploymentResult(itemHash, rootfsRef, apiHost)
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (lastResult.status === 'processed' || lastResult.status === 'rejected') {
      return lastResult
    }
    await sleep(delayMs)
    lastResult = await inspectDeploymentResult(itemHash, rootfsRef, apiHost)
  }
  return lastResult
}

async function fetchSchedulerAllocation(itemHash) {
  const { response, payload } = await fetchJson(`${SCHEDULER_ALLOCATION_URL}/${itemHash}`)
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

async function fetch2n6WebAccessUrl(instanceItemHash) {
  const { response, payload } = await fetchJson(`${TWO_N_SIX_HASH_URL}/${instanceItemHash}`)
  if (!response.ok) return null
  return normalizeProxyUrl(payload?.url ?? payload?.subdomain)
}

async function fetchCrnExecutionMap(crnUrl) {
  const normalizedCrnUrl = String(crnUrl).replace(/\/+$/, '')
  for (const [version, suffix] of [
    ['v2', '/v2/about/executions/list'],
    ['v1', '/about/executions/list']
  ]) {
    const { response, payload } = await fetchJson(`${normalizedCrnUrl}${suffix}`)
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

export async function fetchVmRuntime(args) {
  const crns = args.crns ?? (await fetchCrns(args.crnListUrl ?? CRN_LIST_URL))
  const schedulerAllocation = await fetchSchedulerAllocation(args.itemHash).catch(() => null)
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

  const webAccessUrl = await fetch2n6WebAccessUrl(args.itemHash).catch(() => null)
  let execution = null

  if (allocation?.crnUrl) {
    const executionLookup = await fetchCrnExecutionMap(allocation.crnUrl)
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

  return {
    allocation,
    execution,
    webAccessUrl,
    hostIpv4,
    ipv6,
    proxyUrl,
    mappedPorts: execution?.networking?.mapped_ports ?? {},
    sshCommand: hostIpv4 && sshPort ? `ssh root@${hostIpv4} -p ${sshPort}` : ipv6 ? `ssh root@${ipv6}` : null,
    selectedCrn
  }
}

export async function waitForVmRuntime(args) {
  let lastRuntime = null
  for (let attempt = 0; attempt < Number(args.attempts ?? 20); attempt += 1) {
    lastRuntime = await fetchVmRuntime(args)
    const mappedPorts = lastRuntime?.mappedPorts ?? {}
    if (lastRuntime?.hostIpv4 && Object.keys(mappedPorts).length > 0) {
      return lastRuntime
    }
    await sleep(Number(args.delayMs ?? 4000))
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
  const deployment = await deployVm(args)
  const portForwarding = await ensureInstancePortForwards({
    sender: deployment.sender,
    instanceItemHash: deployment.itemHash,
    requiredPorts: args.requiredPorts ?? defaultRequiredPorts(),
    privateKey: args.privateKey,
    channel: args.channel,
    apiHost: args.apiHost ?? ALEPH_API_HOST
  })
  const deploymentResult = await waitForDeploymentResult(
    deployment.itemHash,
    args.rootfsItemHash,
    args.apiHost ?? ALEPH_API_HOST,
    Number(args.waitAttempts ?? 15),
    Number(args.waitDelayMs ?? 4000)
  )

  const runtime =
    deploymentResult.status === 'processed'
      ? await waitForVmRuntime({
          itemHash: deployment.itemHash,
          crnHash: deployment.selectedCrn?.hash ?? args.crnHash,
          crnListUrl: args.crnListUrl,
          attempts: args.runtimeAttempts ?? args.waitAttempts ?? 20,
          delayMs: args.runtimeDelayMs ?? args.waitDelayMs ?? 4000
        })
      : null

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

  return {
    ...deployment,
    portForwarding,
    deploymentResult,
    runtime,
    configuration,
    verification
  }
}
