#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"

SKIP_TESTS=0
BUILD_TARGET="mac"

usage() {
  cat <<'EOF'
Usage: ./build.sh [options]

Options:
  --skip-tests   Skip the Jest test run before packaging.
  --target <t>   electron-builder target selector. Default: mac
                 Examples: mac, "mac dmg", "mac zip"
  -h, --help     Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --target" >&2
        exit 1
      fi
      BUILD_TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ ! -d node_modules ]]; then
  echo "node_modules is missing. Run 'npm install' first." >&2
  exit 1
fi

echo "Cleaning dist/"
rm -rf "$DIST_DIR"

if [[ "$SKIP_TESTS" -ne 1 ]]; then
  echo "Running test suite"
  npm test -- --runInBand
fi

echo "Building release artifacts for target: $BUILD_TARGET"
read -r -a TARGET_PARTS <<< "$BUILD_TARGET"

case "${TARGET_PARTS[0]:-}" in
  mac)
    TARGET_ARGS=(--mac)
    ;;
  win|windows)
    TARGET_ARGS=(--win)
    ;;
  linux)
    TARGET_ARGS=(--linux)
    ;;
  "")
    echo "Empty build target." >&2
    exit 1
    ;;
  *)
    echo "Unsupported target prefix: ${TARGET_PARTS[0]}" >&2
    echo "Use one of: mac, win, linux" >&2
    exit 1
    ;;
esac

if [[ ${#TARGET_PARTS[@]} -gt 1 ]]; then
  TARGET_ARGS+=("${TARGET_PARTS[@]:1}")
fi

npx electron-builder "${TARGET_ARGS[@]}"

echo "Build complete. Artifacts:"
find "$DIST_DIR" -maxdepth 1 -type f | sort
