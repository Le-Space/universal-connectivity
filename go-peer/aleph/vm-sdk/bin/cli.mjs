#!/usr/bin/env node

import {
  ALEPH_API_HOST,
  CRN_LIST_URL,
  defaultRequiredPorts,
  deployVmAndWait,
  listGeocodedCrns
} from '../lib/aleph-vm-sdk.mjs'

function required(name) {
  const value = process.env[name]
  if (value == null || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function optional(name, fallback = '') {
  return process.env[name] ?? fallback
}

function asInteger(name, fallback) {
  const raw = optional(name, String(fallback))
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer.`)
  }
  return value
}

function asBoolean(name, fallback) {
  const raw = optional(name, fallback ? 'true' : 'false').trim().toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  throw new Error(`${name} must be a boolean-like value.`)
}

function asJson(name, fallback) {
  const raw = optional(name, fallback)
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function appendOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT
  if (!outputFile) return
  const { appendFile } = await import('node:fs/promises')
  await appendFile(outputFile, `${name}=${String(value ?? '')}\n`)
}

async function appendSummary(lines) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (!summaryFile) return
  const { appendFile } = await import('node:fs/promises')
  await appendFile(summaryFile, `${lines.join('\n')}\n`)
}

async function main() {
  const mode = optional('ALEPH_VM_MODE', 'deploy')

  if (mode === 'list-crns') {
    const geocodedCrns = await listGeocodedCrns(optional('ALEPH_VM_CRN_LIST_URL', CRN_LIST_URL))
    const payload = JSON.stringify(geocodedCrns)
    await appendOutput('geocoded_crns_json', payload)
    await appendOutput('geocoded_crn_count', geocodedCrns.length)
    await appendSummary([
      '## Aleph geocoded CRNs',
      '',
      `- Geocoded CRNs: \`${geocodedCrns.length}\``
    ])
    process.stdout.write(`${payload}\n`)
    return
  }

  const deployResult = await deployVmAndWait({
    privateKey: required('ALEPH_VM_PRIVATE_KEY'),
    apiHost: optional('ALEPH_VM_API_HOST', ALEPH_API_HOST),
    crnListUrl: optional('ALEPH_VM_CRN_LIST_URL', CRN_LIST_URL),
    name: required('ALEPH_VM_NAME'),
    sshPublicKey: required('ALEPH_VM_SSH_PUBLIC_KEY'),
    rootfsItemHash: required('ALEPH_VM_ROOTFS_ITEM_HASH'),
    rootfsVersion: optional('ALEPH_VM_ROOTFS_VERSION', ''),
    rootfsSizeMiB: asInteger('ALEPH_VM_ROOTFS_SIZE_MIB', 20480),
    crnHash: required('ALEPH_VM_CRN_HASH'),
    vcpus: asInteger('ALEPH_VM_VCPUS', 1),
    memoryMiB: asInteger('ALEPH_VM_MEMORY_MIB', 1024),
    seconds: asInteger('ALEPH_VM_SECONDS', 30),
    waitAttempts: asInteger('ALEPH_VM_WAIT_ATTEMPTS', 20),
    waitDelayMs: asInteger('ALEPH_VM_WAIT_DELAY_MS', 4000),
    runtimeAttempts: asInteger('ALEPH_VM_RUNTIME_ATTEMPTS', 20),
    runtimeDelayMs: asInteger('ALEPH_VM_RUNTIME_DELAY_MS', 4000),
    setupAttempts: asInteger('ALEPH_VM_SETUP_ATTEMPTS', 15),
    setupDelayMs: asInteger('ALEPH_VM_SETUP_DELAY_MS', 4000),
    verifyAttempts: asInteger('ALEPH_VM_VERIFY_ATTEMPTS', 25),
    verifyDelayMs: asInteger('ALEPH_VM_VERIFY_DELAY_MS', 5000),
    tcpTimeoutMs: asInteger('ALEPH_VM_TCP_TIMEOUT_MS', 5000),
    httpTimeoutMs: asInteger('ALEPH_VM_HTTP_TIMEOUT_MS', 10000),
    autoConfigure: asBoolean('ALEPH_VM_AUTO_CONFIGURE', true),
    verifyReachability: asBoolean('ALEPH_VM_VERIFY_REACHABILITY', true),
    requiredPorts: asJson('ALEPH_VM_REQUIRED_PORTS_JSON', JSON.stringify(defaultRequiredPorts())),
    channel: optional('ALEPH_VM_CHANNEL', 'TEST')
  })

  const runtime = deployResult.runtime
  const runtimeJson = JSON.stringify(runtime ?? {})
  const mappedPortsJson = JSON.stringify(runtime?.mappedPorts ?? {})
  const portForwardingJson = JSON.stringify(deployResult.portForwarding ?? {})
  const configurationJson = JSON.stringify(deployResult.configuration ?? {})
  const verificationJson = JSON.stringify(deployResult.verification ?? {})

  await appendOutput('deployer_address', deployResult.sender)
  await appendOutput('instance_item_hash', deployResult.itemHash)
  await appendOutput('instance_status', deployResult.deploymentResult.status)
  await appendOutput('instance_http_status', deployResult.httpStatus)
  await appendOutput('port_forward_aggregate_item_hash', deployResult.portForwarding?.aggregateItemHash ?? '')
  await appendOutput('port_forward_status', deployResult.portForwarding?.aggregateStatus ?? '')
  await appendOutput('crn_hash', runtime?.selectedCrn?.hash ?? '')
  await appendOutput('crn_name', runtime?.selectedCrn?.name ?? '')
  await appendOutput('crn_url', runtime?.allocation?.crnUrl ?? '')
  await appendOutput('host_ipv4', runtime?.hostIpv4 ?? '')
  await appendOutput('ipv6', runtime?.ipv6 ?? '')
  await appendOutput('web_proxy_url', runtime?.proxyUrl ?? '')
  await appendOutput('ssh_command', runtime?.sshCommand ?? '')
  await appendOutput('setup_endpoint_ok', runtime?.setupHealth?.ok ?? '')
  await appendOutput('mapped_ports_json', mappedPortsJson)
  await appendOutput('configuration_json', configurationJson)
  await appendOutput('verification_json', verificationJson)
  await appendOutput('verification_ok', deployResult.verification?.ok ?? '')
  await appendOutput('port_forwarding_json', portForwardingJson)
  await appendOutput('runtime_json', runtimeJson)

  await appendSummary([
    '## Aleph VM deployment',
    '',
    `- Instance item hash: \`${deployResult.itemHash}\``,
    `- Deployment status: \`${deployResult.deploymentResult.status}\``,
    `- Port-forward aggregate status: \`${deployResult.portForwarding?.aggregateStatus ?? 'unknown'}\``,
    `- CRN: \`${runtime?.selectedCrn?.name ?? runtime?.selectedCrn?.hash ?? 'unknown'}\``,
    `- CRN URL: \`${runtime?.allocation?.crnUrl ?? 'unknown'}\``,
    `- Host IPv4: \`${runtime?.hostIpv4 ?? 'unknown'}\``,
    `- IPv6: \`${runtime?.ipv6 ?? 'unknown'}\``,
    `- Web proxy URL: \`${runtime?.proxyUrl ?? 'unknown'}\``,
    `- SSH command: \`${runtime?.sshCommand ?? 'unknown'}\``,
    `- Setup endpoint reachable before configure: \`${runtime?.setupHealth?.ok ?? 'unknown'}\``,
    `- Verification ok: \`${deployResult.verification?.ok ?? 'unknown'}\``,
    '',
    '### Port mappings',
    '',
    '```json',
    mappedPortsJson,
    '```',
    '',
    '### Reachability checks',
    '',
    '```json',
    verificationJson,
    '```'
  ])

  process.stdout.write(
    `${JSON.stringify({
      itemHash: deployResult.itemHash,
      status: deployResult.deploymentResult.status,
      runtime,
      verification: deployResult.verification
    })}\n`
  )

  if (deployResult.verification && deployResult.verification.ok === false) {
    throw new Error(`Post-configure reachability checks did not all pass: ${verificationJson}`)
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  await appendSummary(['## Aleph VM deployment', '', `- Error: \`${message}\``])
  process.exitCode = 1
})
