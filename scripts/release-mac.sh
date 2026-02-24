#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
APP=src-tauri/target/release/bundle/macos/FlexMap.app
ZIP=FlexMap-macOS-${VERSION}.zip

if [[ ! -d "$APP" ]]; then
  echo "Build output not found: $APP"
  echo "Run: npm run build:portable:mac"
  exit 1
fi

echo "Zipping $APP -> $ZIP"
(cd "$(dirname "$APP")" && ditto -c -k --sequesterRsrc --keepParent FlexMap.app "$OLDPWD/$ZIP")

echo "Creating GitHub release v$VERSION with $ZIP"
gh release create "v$VERSION" "$ZIP" \
  --title "v$VERSION" \
  --notes "FlexMap $VERSION (macOS). Portable .app bundle — unzip and run FlexMap.app."

echo "Done: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$VERSION"
