# Rootfs Profiles

This directory defines relay-owned metadata for Aleph VM rootfs packaging.

The goal is to keep relay-specific packaging inputs in `universal-connectivity`
 while letting the generic qcow2/Aleph publishing logic live elsewhere.

For now, the contract is intentionally narrow and only covers `uc-go-peer`.

## Approach

Each profile file describes:

- which relay subtree is the source of truth
- which rootfs profile name the external builder should use
- the default install mode
- service names and install paths that are useful for review and future tooling
- the expected externally exposed ports

The first consumer of this contract is the GitHub workflow in
`.github/workflows/build-uc-go-peer-rootfs.yml`.
