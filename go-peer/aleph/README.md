# Go Peer Aleph Packaging

This directory contains the Aleph-specific packaging and publishing flow for the
`go-peer` relay.

The main idea is:

- `go-peer` stays the application source of truth
- `go-peer/aleph/root-profiles` defines the packaging contract and exposed ports
- `go-peer/aleph/rootfs` contains the in-repo qcow2 builder and guest bootstrap scripts
- `.github/workflows/build-aleph-go-peer-rootfs.yml` builds and optionally publishes the Aleph VM image

This setup is intentionally narrow. It currently supports only the prebaked
`uc-go-peer` rootfs image and does not try to remain a generic multi-profile VM
builder.

For `uc-go-peer`, the rootfs contract now distinguishes between the relay-owned
support directory at `/opt/go-peer` and the actual guest executable path at
`/usr/local/bin/universal-chat-go`.

## Layout

- `root-profiles/uc-go-peer.json`
  The relay-owned contract for the support directory, executable path, services, port forwards, and manifest notes.
- `rootfs/build-rootfs.sh`
  Top-level orchestrator for local/CI builds, optional Aleph publish, and manifest generation.
- `rootfs/build-rootfs-image.sh`
  The actual qcow2 customization logic using `virt-customize`.
- `rootfs/Dockerfile.rootfs`
  Dockerized Debian/libguestfs build environment used when host tooling is not preferred.
- `rootfs/uc-go-peer-*`
  Guest-side bootstrap, configure, setup, AutoTLS refresh, and systemd service files.

## Diagrams

Current diagram set in this README:

- Repository-level ownership and data flow.
- Reusable workflow end-to-end build, publish, deploy, probe, and republish flow.
- `aleph-vm-deploy` composite action internals.
- Rootfs build orchestration and qcow2 customization path.
- Guest runtime and post-deploy configuration lifecycle.
- Port topology and address-family mapping.
- `js-peer` bootstrap-address resolution and refresh path.

### 1. Repository-Level Flow

```mermaid
flowchart TD
    A[universal-connectivity repo] --> B[go-peer application source]
    A --> C[go-peer/aleph packaging]
    A --> D[js-peer website app]
    A --> E[node-js-peer probe tooling]

    C --> F[root-profiles/uc-go-peer.json]
    C --> G[rootfs/build-rootfs.sh]
    C --> H[rootfs/build-rootfs-image.sh]
    C --> I[rootfs guest bootstrap + setup + describe scripts]
    C --> J[published shared Aleph deploy package]

    K[build-aleph-go-peer-rootfs.yml] --> F
    K --> G
    K --> D
    K --> E
    G --> H
    H --> I
    H --> L[aleph-uc-go-peer.qcow2]
    G --> M[rootfs-manifest.json]
    J --> N[deployed VM metadata, probe addrs, and browser bootstrap addrs]
    D --> O[published js-peer site]
```

### 2. Workflow End-To-End: Rootfs, VM, Probe, Site Republish, And Retention

```mermaid
flowchart TD
    A[Workflow dispatch<br/>build-aleph-go-peer-rootfs.yml] --> B[Checkout universal-connectivity]
    B --> C[Read go-peer/aleph/root-profiles/uc-go-peer.json]
    C --> D[Export contract-derived env<br/>ROOTFS_PROFILE<br/>ROOTFS_INSTALL_MODE<br/>ROOTFS_CONTRACT_FILE]
    D --> E[Install build dependencies<br/>libguestfs/qemu/docker/python]
    E --> F{publish=true?}
    F -- no --> G[Skip Aleph account and site publish]
    F -- yes --> H[Install aleph-client and js-peer publish helpers]
    H --> I[Write ~/.aleph-im/config.json<br/>and ~/.aleph-im/private-keys/aleph-vm.key]
    G --> J[Run go-peer/aleph/rootfs/build-rootfs.sh]
    I --> J
    J --> K[Emit qcow2 and dist-rootfs/rootfs-manifest.json]
    K --> L{publish=true?}
    L -- no --> M[Keep build local to the runner and expose summary outputs only]
    L -- yes --> N[Upload qcow2 to Aleph IPFS add endpoint]
    N --> O[Wait for CID gateway availability]
    O --> P[aleph file pin CID]
    P --> Q[Wait for rootfs STORE message processed]
    Q --> R[Copy rootfs manifest into js-peer/public/rootfs/uc-go-peer]
    R --> S[Build js-peer with latest rootfs manifest only]
    S --> T[Upload js-peer site to IPFS and pin on Aleph]
    T --> U{deploy_vm=true?}
    U -- no --> V[Export site URL and manifest URLs]
    U -- yes --> W[Deploy uc-go-peer VM from rootfs item hash]
    W --> X[Publish required port forwards and wait for runtime mappings]
    X --> Y[Probe temporary setup endpoint on mapped external port for guest port 80]
    Y --> Z[Call guest /configure then poll /metadata]
    Z --> ZA[Collect peer ID, probe multiaddrs, browser bootstrap addrs, and verification data]
    ZA --> ZB{browser bootstrap multiaddrs returned?}
    ZB -- no --> ZC[Keep initial js-peer publish]
    ZB -- yes --> ZD[Rebuild js-peer with NEXT_PUBLIC_RELAY_LISTEN_ADDRS env override]
    ZD --> ZE[Republish js-peer site to IPFS and pin on Aleph]
    ZE --> ZF{main branch with custom domain?}
    ZF -- no --> ZG[Export final site URL and manifest URLs]
    ZF -- yes --> ZH[Relink custom domain to republished js-peer site]
    ZA --> ZJ[Run node-js-peer protocol probes against returned probe_multiaddrs]
    ZJ --> ZK{retain_successful_deployments > 0?}
    ZK -- no --> ZL[Skip retention cleanup]
    ZK -- yes --> ZM[Record current deployment and forget older STORE/INSTANCE messages]
    V --> ZI[Workflow summary and outputs]
    ZC --> ZI
    ZG --> ZI
    ZH --> ZI
    M --> ZI
    ZL --> ZI
    ZM --> ZI
```

### 3. What The `aleph-vm-deploy` Action Actually Does

```mermaid
flowchart TD
    A[Workflow step uses .github/actions/aleph-vm-deploy] --> B[setup-node 24]
    B --> C[npm install @le-space/node@0.1.0 in temp workspace]
    C --> D[node runActionMode from published package]

    D --> E{mode}
    E -->|list-crns| F[Fetch CRN list, enrich geo metadata, output geocoded CRNs]
    E -->|deploy| G[Validate SSH key, rootfs item hash, compute deployer wallet]

    G --> H{rootfs STORE message already processed?}
    H -- no --> I[Wait for rootfs STORE message]
    H -- yes --> J[Continue]
    I --> J

    J --> K{explicit CRN hash provided?}
    K -- yes --> L[Use requested CRN]
    K -- no --> M[Fetch CRNs, rank candidates, prefer country when possible]
    M --> N[Try up to max_crn_attempts distinct CRNs]
    L --> O[Create and sign Aleph INSTANCE message]
    N --> O
    O --> P[Broadcast deployment]
    P --> Q[Wait for Aleph deployment result]
    Q --> R[Publish required port forwards as Aleph aggregate]
    R --> S[Poll CRN runtime for host IP, IPv6, proxy URL, and mapped ports]
    S --> T{auto_configure=true?}
    T -- no --> U[Return runtime outputs only]
    T -- yes --> V[Poll temporary guest setup endpoint]
    V --> W[POST /configure with public IPs, mapped ports, and optional proxy URL]
    W --> X[Poll /metadata until guest reports peer and address families]
    X --> Y{verify_reachability=true?}
    Y -- no --> Z[Return configuration and metadata outputs]
    Y -- yes --> ZA[Check mapped TCP ports and optional HTTPS proxy reachability]
    ZA --> Z[Return verification, metadata, SSH command, and runtime outputs]
```

### 4. What Happens Inside `go-peer/aleph/rootfs`

```mermaid
flowchart TD
    A[build-rootfs.sh] --> B[Resolve repo paths and output directory]
    B --> C[Load ROOTFS_CONTRACT_FILE]
    C --> D[read-rootfs-contract.py]
    D --> E[Emit shell assignments<br/>install paths/services/ports/notes]
    E --> F[Validate uc-go-peer + prebaked mode]
    F --> G[Resolve rootfs version]
    G --> H{SKIP_BUILD?}
    H -- yes --> I[Reuse existing qcow2]
    H -- no --> J{ROOTFS_BUILD_DRIVER}
    J -->|auto on CI| K[Prefer Docker builder]
    J -->|host| L[Use host virt-customize/qemu-img]
    J -->|docker| K
    K --> M[build_with_docker]
    L --> N[build_with_host_tools]
    M --> O[Build go-peer/aleph/rootfs/Dockerfile.rootfs]
    O --> P[Mount universal-connectivity into builder container]
    P --> Q[Run build-rootfs-image.sh inside container]
    N --> Q

    subgraph Image Build Logic
      Q --> R[Download base Debian qcow2 if missing]
      R --> S[Copy and resize base image]
      S --> T[Build universal-chat-go with host/container Go toolchain]
      T --> U[virt-customize --mkdir /opt/go-peer support dir]
      U --> V[virt-customize --mkdir /var/lib/uc-go-peer]
      V --> W[Copy binary to /usr/local/bin and install scripts + systemd units]
      W --> X[Run uc-go-peer-bootstrap.sh base]
      X --> Y[Run uc-go-peer-bootstrap.sh build validation]
      Y --> Z[Run uc-go-peer-bootstrap.sh finalize]
      Z --> ZA[Enable services and produce qcow2]
    end

    ZA --> ZB{SKIP_UPLOAD?}
    ZB -- yes --> ZC[write_manifest without item hash]
    ZB -- no --> ZD[upload_image]
    ZD --> ZE[curl POST file to ipfs.aleph.cloud/api/v0/add]
    ZE --> ZF[Parse CID from ipfs-add-response.jsonl]
    ZF --> ZG[Wait until CID is retrievable from Aleph IPFS gateway]
    ZG --> ZH[Run aleph file pin CID]
    ZH --> ZI[Wait for STORE message processed]
    ZI --> ZJ[Parse item_hash from store-message.json]
    ZC --> ZK[rootfs-manifest.json<br/>profile/version/ports/notes]
    ZJ --> ZK[rootfs-manifest.json<br/>profile/version/ports/notes/item hash]
```

### 5. Runtime Behavior Inside The VM

```mermaid
flowchart TD
    A[First boot of Aleph VM] --> B{Ready file exists?}
    B -- no --> C[uc-go-peer-bootstrap.service exposes setup API on port 80]
    C --> D[Deployment calls /configure with public IPs, mapped ports, and optional proxy URL]
    D --> E[uc-go-peer-configure.sh writes /etc/default/uc-go-peer]
    E --> F[Enable + restart uc-go-peer.service]
    F --> G{Proxy hostname requested?}
    G -- no --> H[Stop Caddy and keep direct forwarded ports as primary path]
    G -- yes --> I[Render Caddyfile for the 2n6 hostname and start Caddy on 443]
    I --> J[Enable + restart uc-go-peer-autotls-refresh.service]
    J --> K[AutoTLS refresh waits for exact WSS hostnames in logs, rewrites announce addrs, and restarts go-peer when needed]
    H --> L[POST /configure replies configured and starts async metadata generation]
    K --> M[GET /metadata returns peer ID plus direct TCP, AutoTLS WSS, proxy WSS, WebTransport, and webrtc-direct addrs]
    L --> M
    M --> N[Setup server shuts itself down and stops bootstrap service]

    B -- yes --> F

    F --> O[universal-chat-go listens on 9095 for raw TCP and UDP]
    F --> P[universal-chat-go listens on 9096 for plain WS backend traffic from Caddy]
    F --> Q[universal-chat-go listens on 9097 for direct secure WSS and AutoTLS]
    O --> R[Logs emit peer ID and listening multiaddrs]
    P --> R
    Q --> R
    R --> S[uc-go-peer-describe.py groups probe addrs and browser bootstrap addrs]
    S --> T[Workflow probes returned multiaddrs and optionally rebuilds js-peer]
```

### 6. Port Topology And Address Families

```mermaid
flowchart LR
    A[Aleph mapped host ports] --> B[VM port 80<br/>temporary setup API]
    A --> C[VM port 443<br/>Caddy TLS frontend for 2n6 hostname]
    A --> D[VM port 9095<br/>raw relay TCP and UDP]
    A --> E[VM port 9097<br/>direct secure WSS and AutoTLS]

    C --> F[VM port 9096<br/>plain WS backend]
    F --> G[go-peer plain WS transport]
    D --> H[go-peer raw TCP and UDP transports]
    E --> I[go-peer secure WSS transport]

    H --> J[Announced direct TCP and UDP addrs]
    I --> K[Announced libp2p.direct WSS addrs]
    C --> L[Announced 2n6 proxy WSS addrs]
    D --> M[Announced WebTransport and webrtc-direct addrs]
```

### 7. How `js-peer` Gets Its Relay Bootstrap Addresses

```mermaid
flowchart TD
    A[js-peer build starts] --> B{NEXT_PUBLIC_RELAY_LISTEN_ADDRS set in build env?}
    B -- yes --> C[Use explicit browser relay multiaddrs from workflow]
    B -- no --> D[Use NEXT_PUBLIC_BOOTSTRAP_PEER_IDS or built-in BOOTSTRAP_PEER_IDS]
    D --> E[Query delegated routing for peer records]
    E --> F[Filter browser-dialable addrs:<br/>tls/ws, webtransport, or webrtc-direct]
    F --> G[Append /p2p/peerId]
    C --> H[Ship compiled site with resolved relay bootstrap list]
    G --> H

    I[Workflow first publish] --> J[js-peer/public/rootfs/uc-go-peer/latest.json]
    I --> K[js-peer/public/rootfs/uc-go-peer/versioned manifest json]
    J --> H
    K --> H

    L[Workflow second publish after VM deploy] --> M[Guest returns browser_bootstrap_multiaddrs_json<br/>proxy WSS, AutoTLS WSS, WebTransport, webrtc-direct]
    M --> N[Workflow sets NEXT_PUBLIC_RELAY_LISTEN_ADDRS only for rebuild]
    N --> H
```

## File Ownership Guide

- `universal-connectivity/go-peer/go-peer`
  The application binary source tree that gets packaged into the image.
- `universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json`
  Relay-owned contract for install mode, directories, services, port forwards, and manifest notes.
- `universal-connectivity/go-peer/aleph/rootfs/build-rootfs.sh`
  Top-level rootfs orchestration, builder selection, upload orchestration, and manifest writing.
- `universal-connectivity/go-peer/aleph/rootfs/read-rootfs-contract.py`
  Adapter from contract JSON to shell environment variables.
- `universal-connectivity/go-peer/aleph/rootfs/build-rootfs-image.sh`
  qcow2 customization logic for the prebaked `uc-go-peer` image.
- `universal-connectivity/go-peer/aleph/rootfs/uc-go-peer-bootstrap.sh`
  Guest-side base/build/finalize provisioning inside the image.
- `universal-connectivity/go-peer/aleph/rootfs/uc-go-peer-configure.sh`
  Post-deployment port/public-IP configuration inside the VM.
- `universal-connectivity/go-peer/aleph/rootfs/uc-go-peer-setup-server.py`
  Temporary HTTP setup endpoint that accepts Aleph port-mapping information.
- `universal-connectivity/go-peer/aleph/rootfs/uc-go-peer-autotls-refresh.py`
  AutoTLS reachability wait, libp2p.direct certificate acquisition, and restart after secure WSS hostnames become available.
- `universal-connectivity/go-peer/aleph/rootfs/uc-go-peer-describe.py`
  Guest-side metadata extractor used after configuration to report the relay peer ID plus probe, browser bootstrap, WebTransport, and webrtc-direct multiaddrs.
- `universal-connectivity/.github/workflows/build-aleph-go-peer-rootfs.yml`
  CI entrypoint for building and optionally publishing the Aleph rootfs image.
- `universal-connectivity/.github/workflows/uc-go-peer-rootfs-reusable.yml`
  Main reusable workflow that builds the rootfs, publishes manifests, optionally deploys the VM, runs protocol probes, and republishes `js-peer` with deployed relay addresses.

## Headless VM Deploy Path

For workflow-driven VM creation, `universal-connectivity` now consumes the
published shared Node package from the standalone shared repo instead of
keeping a local Aleph VM SDK copy.

- `@le-space/node`
  Published shared Node adapter package that now owns the reusable headless
  deploy logic for:
  `listGeocodedCrns()`
  deployment creation and signing
  Aleph result polling
  runtime inspection
  guest configuration
  retention cleanup
- `.github/actions/aleph-vm-deploy/action.yml` (thin UC wrapper around the published shared Aleph tooling package path)
  Composite GitHub Action wrapper that installs `@le-space/node@0.1.0` and returns:
  host IPv4, IPv6, proxy URL, mapped ports JSON, a ready-to-use SSH command,
  setup-endpoint reachability, and post-configure verification results.

The important architectural split is:

- the PWA still owns the browser signing flow
- the published shared Node package uses a headless EVM private key for GitHub Actions
- for `uc-go-peer`, the action also publishes the required Aleph port-forward
  aggregate, waits for runtime mappings, calls the temporary setup endpoint on
  the mapped external port for internal `80`, and then verifies the durable
  ports after configuration

Example workflow usage:

```yaml
- name: Deploy uc-go-peer VM on Aleph
  id: deploy_vm
  uses: ./.github/actions/aleph-vm-deploy
  with:
    aleph_private_key: ${{ secrets.ALEPH_PRIVATE_KEY }}
    name: uc-go-peer-demo
    ssh_public_key: ${{ secrets.VM_SSH_PUBLIC_KEY }}
    rootfs_item_hash: ${{ needs.build_rootfs.outputs.rootfs_item_hash }}
    rootfs_size_mib: '20480'
    crn_hash: ${{ vars.ALEPH_CRN_HASH }}
    vcpus: '1'
    memory_mib: '1024'
    auto_configure: 'true'
    verify_reachability: 'true'

- name: Show resulting access details
  run: |
    echo "Host IPv4: ${{ steps.deploy_vm.outputs.host_ipv4 }}"
    echo "Setup endpoint was reachable: ${{ steps.deploy_vm.outputs.setup_endpoint_ok }}"
    echo "Proxy URL: ${{ steps.deploy_vm.outputs.web_proxy_url }}"
    echo "SSH: ${{ steps.deploy_vm.outputs.ssh_command }}"
    echo "Ports: ${{ steps.deploy_vm.outputs.mapped_ports_json }}"
    echo "Verification: ${{ steps.deploy_vm.outputs.verification_json }}"
```

## Published Site Bootstrap Refresh

When the reusable workflow is run with both `publish=true` and `deploy_vm=true`,
it now performs a two-pass `js-peer` publish:

1. Build and publish the rootfs image, rootfs manifests, and an initial
   `js-peer` site.
2. Deploy the `uc-go-peer` VM and wait for the guest to report its final relay
   multiaddrs.
3. Extract browser-dialable relay addresses from the deployed
   VM metadata.
4. Rebuild `js-peer` with `NEXT_PUBLIC_RELAY_LISTEN_ADDRS` set to those final
   deployed relay addresses.
5. Republish the `js-peer` site and, on `main`, relink the custom domain to the
   republished site.

This keeps the live website bootstrap list aligned with the relay that was just
deployed instead of leaving the site pointed at stale bootstrap addresses.

One important implementation detail:

- the workflow does not edit a checked-in `.env` file in the repository
- instead, the second `js-peer` build injects `NEXT_PUBLIC_RELAY_LISTEN_ADDRS`
  as a build-time environment variable
- `js-peer/src/lib/libp2p.ts` prefers that variable over delegated-routing
  bootstrap discovery when it is present
- the injected list now carries the browser-usable relay families returned by
  the VM metadata step: proxy WSS, AutoTLS WSS, WebTransport, and
  `webrtc-direct`
