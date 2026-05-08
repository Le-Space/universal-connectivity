# Rootfs Profiles

This directory defines relay-owned metadata for Aleph VM rootfs packaging.

The goal is to keep relay-specific packaging inputs in `universal-connectivity`
 while letting the generic qcow2/Aleph publishing logic live elsewhere.

For now, the contract is intentionally narrow and only covers `uc-go-peer`.

## Current Approach

Each profile file describes:

- which relay subtree is the source of truth
- which rootfs profile name the external builder should use
- the default install mode
- service names and install paths that are useful for review and future tooling
- the expected externally exposed ports

The first consumer of this contract is the GitHub workflow in
`.github/workflows/build-uc-go-peer-rootfs.yml`.

## Why Keep This In Universal Connectivity

`universal-connectivity` owns the relay source, build intent, ports, and
service-level behavior. The separate rootfs builder repository should not be
the place where those relay details are invented.

## Why JSON

The first workflow parses the contract with Python's standard library to avoid
adding `yq` or another parser dependency on the GitHub runner. If the contract
grows, switching to YAML later is straightforward.

## Likely Next Step

If this pattern works well for `uc-go-peer`, add sibling files for:

- `uc-rust-peer`
- `py-libp2p`
- `orbitdb-relay-pinner`

At that point the external rootfs builder can be refactored to consume these
profile files directly instead of hardcoded per-relay shell branches.
