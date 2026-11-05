#!/bin/sh
# Builds the Mac app (Apple silicon and Intel) and puts each in a .dmg. Runs on a Mac
# (GitHub's, see .github/workflows). The app is signed "ad hoc" (no Apple developer ID), which
# Apple silicon needs for any app to start; macOS asks you to allow it the first time.
# Usage: tools/mac-build.sh VERSION
set -e
V="$1"; [ -n "$V" ] || { echo "usage: tools/mac-build.sh VERSION"; exit 1; }
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 --x64 --publish never
for pair in "mac-arm64:apple-silicon" "mac:intel"; do
  d="dist/${pair%%:*}"; name="${pair##*:}"; app="$d/Couch Launcher.app"
  [ -d "$app" ] || { echo "missing $app"; exit 1; }
  # koffi's macOS library first, then the whole app.
  find "$app/Contents/Resources" -path '*darwin*' -name '*.node' -exec codesign --force --sign - {} \;
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"
  stage="$(mktemp -d)"; cp -R "$app" "$stage/"; ln -s /Applications "$stage/Applications"
  # hdiutil sometimes says "Resource busy" on GitHub's Macs: try again a few times.
  ok=""
  for try in 1 2 3 4 5; do
    if hdiutil create -volname "Couch Launcher" -srcfolder "$stage" -ov -format UDZO "dist/CouchLauncher-$V-mac-$name.dmg"; then ok=1; break; fi
    sleep $((try * 5))
  done
  [ -n "$ok" ] || { echo "Couldn't make the .dmg"; exit 1; }
  rm -rf "$stage"
done
ls -la dist/*.dmg
