#!/bin/sh
# Builds CouchLauncher-update-<version>.zip: version.json + src. Usage: ./make-update.sh 1.1.1 "What changed"
set -e
V="$1"; NOTES="$2"
T=$(mktemp -d); cp -r src "$T/"
python3 -c "import json,sys; json.dump({'version':sys.argv[1],'notes':sys.argv[2]}, open(sys.argv[3],'w'))" "$V" "$NOTES" "$T/version.json"
rm -f "CouchLauncher-update-$V.zip"; (cd "$T" && zip -qr "$OLDPWD/CouchLauncher-update-$V.zip" version.json src); rm -rf "$T"
echo "CouchLauncher-update-$V.zip"
