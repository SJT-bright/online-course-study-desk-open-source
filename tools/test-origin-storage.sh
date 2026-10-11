#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp/}studydesk-origin-test.XXXXXX")"
TEST_ID="$(basename "$TEST_DIR")"
trap 'rm -rf "$TEST_DIR" "$HOME/Library/WebKit/$TEST_ID"' EXIT
xcrun swiftc "$ROOT/tests/origin-storage.swift" "$ROOT/macos/OriginStorage.swift" \
  -o "$TEST_DIR/$TEST_ID" -framework AppKit -framework WebKit \
  -module-cache-path "$ROOT/macos/build/module-cache" \
  -Xfrontend -interface-compiler-version -Xfrontend 6.3.2
"$TEST_DIR/$TEST_ID" "$ROOT/lib/origin-storage.js"
