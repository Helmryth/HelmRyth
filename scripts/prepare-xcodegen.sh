#!/bin/sh

set -eu

XCODEGEN_VERSION="2.46.0"
XCODEGEN_ARCHIVE="xcodegen.zip"
XCODEGEN_ARCHIVE_SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"
XCODEGEN_BINARY_SHA256="8774da746668bc18fe74e54cbaf10f2631a1fb05947cd374179aa912f14f99db"
XCODEGEN_URL="https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/${XCODEGEN_ARCHIVE}"

usage() {
  echo "Usage: scripts/prepare-xcodegen.sh [--print-bin | --run <xcodegen args...>]" >&2
  exit 1
}

sha256_file() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

sha256_matches() {
  actual="$(sha256_file "$1")"
  [ "$actual" = "$2" ]
}

verify_file_sha256() {
  actual="$(sha256_file "$1")"
  expected="$2"
  label="$3"
  if [ "$actual" != "$expected" ]; then
    echo "${label} SHA-256 mismatch: expected ${expected}, got ${actual}" >&2
    exit 1
  fi
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "prepare-xcodegen is macOS-only" >&2
  exit 1
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE_BASE="${HELMRYTH_XCODEGEN_CACHE_DIR:-${ROOT_DIR}/node_modules/.cache/helmryth}"
CACHE_DIR="${CACHE_BASE}/xcodegen-${XCODEGEN_VERSION}"
STAGE_DIR="${CACHE_DIR}/xcodegen"
ARCHIVE_PATH="${CACHE_DIR}/${XCODEGEN_ARCHIVE}"
BIN_PATH="${STAGE_DIR}/bin/xcodegen"
PRESET_PATH="${STAGE_DIR}/share/xcodegen/SettingPresets/base.yml"
MANIFEST_PATH="${CACHE_DIR}/manifest.txt"

verify_stage() {
  [ -f "$ARCHIVE_PATH" ] || return 1
  [ -x "$BIN_PATH" ] || return 1
  [ -f "$PRESET_PATH" ] || return 1
  sha256_matches "$ARCHIVE_PATH" "$XCODEGEN_ARCHIVE_SHA256" || return 1
  sha256_matches "$BIN_PATH" "$XCODEGEN_BINARY_SHA256" || return 1
  [ -f "$MANIFEST_PATH" ] || return 1
  grep -qx "version=${XCODEGEN_VERSION}" "$MANIFEST_PATH"
  grep -qx "archive_sha256=${XCODEGEN_ARCHIVE_SHA256}" "$MANIFEST_PATH"
  grep -qx "binary_sha256=${XCODEGEN_BINARY_SHA256}" "$MANIFEST_PATH"
}

stage_xcodegen() {
  mkdir -p "$CACHE_BASE"
  scratch=$(mktemp -d "${CACHE_BASE}/.xcodegen-stage.XXXXXX")
  cleanup() {
    rm -rf "$scratch"
  }
  trap cleanup EXIT INT TERM HUP

  curl -fsSL --retry 3 --retry-all-errors --output "${scratch}/${XCODEGEN_ARCHIVE}" "$XCODEGEN_URL"
  verify_file_sha256 "${scratch}/${XCODEGEN_ARCHIVE}" "$XCODEGEN_ARCHIVE_SHA256" "${XCODEGEN_ARCHIVE}"

  unzip -q "${scratch}/${XCODEGEN_ARCHIVE}" -d "$scratch"
  [ -x "${scratch}/xcodegen/bin/xcodegen" ] || {
    echo "xcodegen.zip did not contain xcodegen/bin/xcodegen" >&2
    exit 1
  }
  [ -f "${scratch}/xcodegen/share/xcodegen/SettingPresets/base.yml" ] || {
    echo "xcodegen.zip did not contain the shared SettingPresets payload" >&2
    exit 1
  }
  verify_file_sha256 "${scratch}/xcodegen/bin/xcodegen" "$XCODEGEN_BINARY_SHA256" "xcodegen binary"

  rm -rf "$CACHE_DIR"
  mkdir -p "$CACHE_DIR"
  mv "${scratch}/xcodegen" "$STAGE_DIR"
  mv "${scratch}/${XCODEGEN_ARCHIVE}" "$ARCHIVE_PATH"
  cat <<EOF > "$MANIFEST_PATH"
version=${XCODEGEN_VERSION}
archive_sha256=${XCODEGEN_ARCHIVE_SHA256}
binary_sha256=${XCODEGEN_BINARY_SHA256}
source=${XCODEGEN_URL}
EOF
  trap - EXIT INT TERM HUP
  cleanup
}

if ! verify_stage >/dev/null 2>&1; then
  stage_xcodegen
fi

case "${1:-}" in
  "")
    printf '%s\n' "$BIN_PATH"
    ;;
  --print-bin)
    [ "$#" -eq 1 ] || usage
    printf '%s\n' "$BIN_PATH"
    ;;
  --run)
    [ "$#" -ge 2 ] || usage
    shift
    exec "$BIN_PATH" "$@"
    ;;
  *)
    usage
    ;;
esac
