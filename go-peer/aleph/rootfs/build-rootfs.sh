#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALEPH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-${ALEPH_DIR}/dist-rootfs}"
ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE:-${ALEPH_DIR}/root-profiles/uc-go-peer.json}"
ROOTFS_BUILD_DRIVER="${ROOTFS_BUILD_DRIVER:-auto}"
ROOTFS_SIZE_MIB="${ROOTFS_SIZE_MIB:-20480}"
ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE:-20G}"
ROOTFS_VERSION="${ROOTFS_VERSION:-}"
CHANNEL="${CHANNEL:-ALEPH-CLOUDSOLUTIONS}"
SKIP_UPLOAD="${SKIP_UPLOAD:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
IPFS_ADD_URL="${IPFS_ADD_URL:-https://ipfs.aleph.cloud/api/v0/add}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

die() {
  echo "$*" >&2
  exit 1
}

load_rootfs_contract() {
  require python3
  [ -f "${ROOTFS_CONTRACT_FILE}" ] || die "Rootfs contract does not exist: ${ROOTFS_CONTRACT_FILE}"

  eval "$(python3 "${SCRIPT_DIR}/read-rootfs-contract.py" "${ROOTFS_CONTRACT_FILE}")"

  if [ "${ROOTFS_CONTRACT_PROFILE}" != "uc-go-peer" ]; then
    die "Only the uc-go-peer rootfs profile is supported, got: ${ROOTFS_CONTRACT_PROFILE}"
  fi
  if [ "${ROOTFS_CONTRACT_INSTALL_MODE}" != "prebaked" ]; then
    die "Only prebaked install mode is supported, got: ${ROOTFS_CONTRACT_INSTALL_MODE}"
  fi
}

resolve_rootfs_version() {
  if [ -n "${ROOTFS_VERSION}" ]; then
    printf '%s\n' "${ROOTFS_VERSION}"
    return
  fi

  if [ -d "${PROJECT_DIR}/.git" ]; then
    local short_sha
    short_sha="$(git -C "${PROJECT_DIR}" rev-parse --short HEAD)"
    local build_date
    build_date="$(date -u +%Y%m%d)"
    printf 'uc-go-peer-git-%s-%s\n' "${build_date}" "${short_sha}"
    return
  fi

  printf 'uc-go-peer-v0.1.0\n'
}

resolve_aleph_bin() {
  if [ -n "${ALEPH_BIN:-}" ]; then
    printf '%s\n' "${ALEPH_BIN}"
    return
  fi

  if command -v aleph >/dev/null 2>&1; then
    command -v aleph
    return
  fi

  die "Missing aleph CLI. Set ALEPH_BIN=/path/to/aleph or install aleph-client."
}

build_with_host_tools() {
  echo "Using host virt-customize/qemu-img toolchain."
  ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE}" \
  OUT_DIR="${OUT_DIR}" \
  ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE}" \
  PROJECT_DIR="${PROJECT_DIR}" \
  bash "${SCRIPT_DIR}/build-rootfs-image.sh"
}

build_with_docker() {
  require docker

  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed, but the Docker daemon is not running."
  fi

  echo "Using Dockerized Debian/libguestfs builder."
  docker build --platform linux/amd64 \
    -t uc-go-peer-rootfs-builder:local \
    -f "${SCRIPT_DIR}/Dockerfile.rootfs" \
    "${SCRIPT_DIR}"

  docker run --rm --privileged --platform linux/amd64 \
    -e LIBGUESTFS_BACKEND=direct \
    -e ROOTFS_CONTRACT_FILE=/workspace/universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json \
    -e OUT_DIR=/workspace/universal-connectivity/go-peer/aleph/dist-rootfs \
    -e ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE}" \
    -e PROJECT_DIR=/workspace/universal-connectivity \
    -v "${PROJECT_DIR}:/workspace/universal-connectivity" \
    -w /workspace/universal-connectivity/go-peer/aleph \
    uc-go-peer-rootfs-builder:local \
    bash rootfs/build-rootfs-image.sh
}

write_manifest() {
  local rootfs_item_hash="${1:-}"
  local rootfs_source_size_bytes=""

  if [ -f "${OUT_DIR}/ipfs-add-response.jsonl" ]; then
    rootfs_source_size_bytes="$(python3 - "${OUT_DIR}/ipfs-add-response.jsonl" <<'PY'
import json
import sys
from pathlib import Path

lines = [line for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit(0)

payload = json.loads(lines[-1])
size = payload.get("Size")
if isinstance(size, str) and size.isdigit():
    print(size)
elif isinstance(size, int) and size > 0:
    print(size)
PY
)"
  fi

  {
    echo '{'
    echo '  "profile": "uc-go-peer",'
    echo "  \"version\": \"${ROOTFS_VERSION}\","
    echo '  "rootfsInstallStrategy": "prebaked",'
    echo '  "requiresBootstrapNetwork": false,'
    echo '  "bootstrapSummary": "Dependencies are preinstalled in the image.",'
    if [[ "${rootfs_source_size_bytes}" =~ ^[0-9]+$ ]]; then
      echo "  \"rootfsSourceSizeBytes\": ${rootfs_source_size_bytes},"
    fi
    printf '  "requiredPortForwards": %s,\n' "${ROOTFS_CONTRACT_PORT_FORWARDS_JSON}"
    if [ -n "${rootfs_item_hash}" ]; then
      echo "  \"rootfsItemHash\": \"${rootfs_item_hash}\","
    fi
    echo "  \"rootfsSizeMiB\": ${ROOTFS_SIZE_MIB},"
    echo "  \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    printf '  "notes": "%s"\n' "${ROOTFS_CONTRACT_MANIFEST_NOTES}"
    echo '}'
  } > "${OUT_DIR}/rootfs-manifest.json"

  echo "Rootfs manifest written to ${OUT_DIR}/rootfs-manifest.json"
}

upload_image() {
  local aleph_bin
  aleph_bin="$(resolve_aleph_bin)"

  require python3
  require curl

  local image="${OUT_DIR}/aleph-uc-go-peer.qcow2"
  [ -f "${image}" ] || die "Rootfs image does not exist: ${image}"

  echo "Uploading ${image} to IPFS via ${IPFS_ADD_URL}..."
  : > "${OUT_DIR}/ipfs-add-response.jsonl"
  if ! curl --fail --silent --show-error \
    -X POST \
    -F "file=@${image}" \
    "${IPFS_ADD_URL}" \
    > "${OUT_DIR}/ipfs-add-response.jsonl"; then
    die "IPFS upload failed for ${image}"
  fi

  local cid
  cid="$(python3 - "${OUT_DIR}/ipfs-add-response.jsonl" <<'PY'
import json
import sys
from pathlib import Path

lines = [line for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit("No response received from the IPFS add endpoint")

payload = json.loads(lines[-1])
cid = payload.get("Hash")
if not cid:
    raise SystemExit(f"IPFS add response did not include a Hash: {payload}")

print(cid)
PY
)" || die "Failed to extract CID from ${OUT_DIR}/ipfs-add-response.jsonl"

  echo "Pinning CID ${cid} on Aleph Cloud..."
  : > "${OUT_DIR}/store-message.json"
  if ! "${aleph_bin}" file pin "${cid}" \
    --channel "${CHANNEL}" \
    > "${OUT_DIR}/store-message.json"; then
    die "Aleph pin failed for CID ${cid}"
  fi

  python3 - "${OUT_DIR}/store-message.json" <<'PY'
import json
import sys
from pathlib import Path

content = Path(sys.argv[1]).read_text().strip()
if not content:
    raise SystemExit("Aleph pin returned an empty response")

payload = json.loads(content)
print(payload["item_hash"])
PY
}

mkdir -p "${OUT_DIR}"
load_rootfs_contract
ROOTFS_VERSION="$(resolve_rootfs_version)"

echo "Building rootfs profile: uc-go-peer"
echo "Using install mode: prebaked"

if [ "${SKIP_BUILD}" != "1" ]; then
  case "${ROOTFS_BUILD_DRIVER}" in
    host)
      if command -v virt-customize >/dev/null 2>&1; then
        build_with_host_tools
      else
        die "ROOTFS_BUILD_DRIVER=host requested, but virt-customize is not available."
      fi
      ;;
    docker)
      build_with_docker
      ;;
    auto)
      if [ "${GITHUB_ACTIONS:-}" = "true" ] && command -v docker >/dev/null 2>&1; then
        build_with_docker
      elif command -v virt-customize >/dev/null 2>&1; then
        build_with_host_tools
      else
        build_with_docker
      fi
      ;;
    *)
      die "Unsupported ROOTFS_BUILD_DRIVER: ${ROOTFS_BUILD_DRIVER}"
      ;;
  esac
else
  [ -f "${OUT_DIR}/aleph-uc-go-peer.qcow2" ] || die "SKIP_BUILD=1 requested, but image is missing."
fi

if [ "${SKIP_UPLOAD}" = "1" ]; then
  write_manifest
  echo "SKIP_UPLOAD=1 set; image ready at ${OUT_DIR}/aleph-uc-go-peer.qcow2"
  exit 0
fi

ROOTFS_ITEM_HASH="$(upload_image)"
write_manifest "${ROOTFS_ITEM_HASH}"
