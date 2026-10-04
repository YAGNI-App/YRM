#!/bin/sh
# Run the Acme demo against a compiled yrm binary, outside the repository so
# nothing resolves from the workspace's node_modules.
#
#   sh scripts/smoke.sh dist/yrm-bun-linux-x64
#
# Covers: init, a yrm.config.ts that imports @yrm/core, import (40 events),
# today, doctor, a project extension in .yrm/extensions, and the web
# dashboard with its embedded static files.
set -eu

BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
WEB_PID=""
cleanup() {
  if [ -n "$WEB_PID" ]; then kill "$WEB_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

fail() {
  echo "smoke: $*" >&2
  exit 1
}

echo "== version"
"$BIN" --version

echo "== init in an empty directory"
mkdir "$WORK/fresh"
(cd "$WORK/fresh" && "$BIN" init --self jack@yagni.example --domain yagni.example && "$BIN" doctor >/dev/null) || fail "init or doctor failed"

echo "== import the Acme corpus with its own config"
cp -R "$REPO/fixtures/acme" "$WORK/acme"
rm -rf "$WORK/acme/.yrm"
cd "$WORK/acme"
grep -q 'from "@yrm/core"' yrm.config.ts || fail "the fixture config no longer imports @yrm/core; this check needs one that does"
"$BIN" import . 2>/dev/null | tee import.txt
grep -Eq "events created +40$" import.txt || fail "expected 40 events created"

echo "== today"
"$BIN" today --date 2026-10-03 2>/dev/null | tee today.txt | head -8
head -8 today.txt | grep -q "Marcus Bell" || fail "Marcus Bell is not near the top of the queue"

echo "== doctor"
"$BIN" doctor >doctor.txt 2>&1 || { cat doctor.txt; fail "doctor failed"; }
for ext in mail calendar notes resolve extract attention mcp web; do
  grep -Eq "^  $ext +built-in" doctor.txt || { cat doctor.txt; fail "built-in extension $ext is not loaded"; }
done

echo "== project extension"
mkdir -p .yrm/extensions
cat >.yrm/extensions/smoke.ts <<'EOF'
import { YrmError, type ExtensionAPI } from "@yrm/core";
export default function (yrm: ExtensionAPI) {
  yrm.registerCommand({ name: "smoke", description: "smoke test", async run(ctx) { ctx.stdout(`ok ${typeof YrmError}`); return 0; } });
}
EOF
[ "$("$BIN" smoke)" = "ok function" ] || fail "project extension did not load"

echo "== web"
"$BIN" web --port 0 >web.txt 2>&1 &
WEB_PID=$!
url=""
for _ in $(seq 1 50); do
  url=$(grep -o 'http://[^ ]*' web.txt || true)
  [ -n "$url" ] && break
  sleep 0.1
done
[ -n "$url" ] || { cat web.txt; fail "web did not start"; }
curl -fsS "$url" | grep -q "Marcus Bell" || fail "dashboard did not render the queue"
curl -fsS "${url}static/styles.css" | grep -q "{" || fail "embedded styles.css not served"
curl -fsS "${url}static/app.js" >/dev/null || fail "embedded app.js not served"
kill "$WEB_PID"
wait "$WEB_PID" || true
WEB_PID=""

echo "smoke: ok"
