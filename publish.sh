#!/bin/sh
# Publishes an update online: builds the update zip, puts it in the GitHub repo's updates/
# folder with updates/latest.json, and pushes. Launchers pick it up by themselves.
# Usage: ./publish.sh 1.3.1 "What changed"   (REPO = local clone of c-launch/couch-launcher)
set -e
V="$1"; NOTES="$2"; REPO="${REPO:-/home/claude/gh-couch-launcher}"
[ -n "$V" ] && [ -n "$NOTES" ] || { echo "usage: ./publish.sh VERSION NOTES"; exit 1; }
# Never publish a version that can't start (1.6.0/1.6.1 couldn't: an ordering mistake).
node tools/smoke-test.js && node tools/smoke-test.js --mac || { echo "Not published: the startup check failed."; exit 1; }
# Nor one where the guide can leave a game frozen in front or the launcher takes the controller
# from a game (1.27.6 and earlier could, with GTA V and Fortnite).
node tools/focus-guard-test.js && node tools/guide-flow-test.js || { echo "Not published: the guide check failed."; exit 1; }
# Nor one where the pop-ups or the Discord call on screen misbehave (they sit above games).
node tools/pops-test.js && node tools/discord-live-test.js || { echo "Not published: the pop-ups check failed."; exit 1; }
# Nor one where the fail-safes don't hold: an update that can't show its screen is dropped for
# the built-in app, saved files survive a cut-off save, Cable TV's schedule has no holes (also on
# the days the clocks change) and swaps in another episode or restarts its player when one fails.
# And a store game's programs are followed correctly without starting PowerShell each time.
node tools/procs-test.js && node tools/update-failsafe-test.js && node tools/safe-files-test.js && TZ=America/New_York node tools/cable-schedule-test.js && node tools/cable-fallback-test.js || { echo "Not published: a fail-safe check failed."; exit 1; }
# Nor one where Couch TV (the same Movies & TV as an app of its own) can't start, or where the
# two would lose each other's addons, list, history or sign-in (they keep them in the same files).
node tools/shared-data-test.js && node tools/couch-tv-test.js || { echo "Not published: the Couch TV check failed."; exit 1; }
python3 -c "import json,sys; p='package.json'; d=json.load(open(p)); d['version']=sys.argv[1]; open(p,'w').write(json.dumps(d, indent=2)+'\\n')" "$V"
./make-update.sh "$V" "$NOTES" >/dev/null
Z="CouchLauncher-update-$V.zip"
mkdir -p "$REPO/updates"
rm -f "$REPO"/updates/CouchLauncher-update-*.zip
cp "$Z" "$REPO/updates/"
python3 -c "import json,os,sys; json.dump({'version':sys.argv[1],'notes':sys.argv[2],'file':sys.argv[3],'size':os.path.getsize(sys.argv[4])}, open(sys.argv[5],'w'), ensure_ascii=False, indent=1)" "$V" "$NOTES" "$Z" "$Z" "$REPO/updates/latest.json"
rm -rf "$REPO/src" "$REPO/build" "$REPO/tools" "$REPO/docs"; cp -r src build tools docs .github README.md Build.bat "Try it (windowed).bat" make-update.sh publish.sh package.json couchtv.build.json "$REPO/"
cd "$REPO"
git add -A
git commit -q -m "Couch Launcher $V

$NOTES

Claude-Session: https://claude.ai/code/session_01VkLb4Dg9CpUrgE4zjtmw75"
git push -q origin HEAD:main 2>&1 | grep -v "push negotiation" || true
echo "published $V"
