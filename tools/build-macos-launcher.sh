#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/macos/build"
mkdir -p "$BUILD/module-cache"
SDK="$(xcrun --show-sdk-path)"
xcrun swiftc -O -target arm64-apple-macosx12.0 -sdk "$SDK" \
  -module-cache-path "$BUILD/module-cache" \
  -Xfrontend -interface-compiler-version -Xfrontend 6.3.2 \
  "$ROOT/macos/StudyDesk.swift" "$ROOT/macos/OriginStorage.swift" -o "$BUILD/StudyDesk" -framework AppKit -framework WebKit
codesign --force --sign - --timestamp=none "$BUILD/StudyDesk"
codesign --verify --strict "$BUILD/StudyDesk"
echo "原生启动器已构建：$BUILD/StudyDesk"
