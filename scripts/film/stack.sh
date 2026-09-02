#!/bin/bash
# Bring up one fully isolated Helmryth stack for a recording or test lane.
#
#   ./stack.sh <lane> <corePort> <uiPort>
#
# Each lane gets its own data directory, core process, static host, and logs, so
# lanes cannot observe or corrupt each other's operators, crews, runs, or
# settings. Provider keys are read from the login Keychain at start time and are
# never written to disk or passed on a command line.
#
# The core binds <corePort> and its webhook receiver binds <corePort>+1, so lane
# ports must be spaced by at least 2. Callers use steps of 10.

set -u

# Resolve the repo from this script's own location — never a hardcoded home.
FILM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$FILM_DIR/../.." && pwd)"
OUT="${HELMRYTH_FILM_OUT:-$REPO/output/film}"

LANE="${1:?usage: stack.sh <lane> <corePort> <uiPort>}"
CORE_PORT="${2:?missing corePort}"
UI_PORT="${3:?missing uiPort}"

LANE_DIR="$OUT/lanes/$LANE"
mkdir -p "$LANE_DIR"/{profile,logs,evidence,pwcli}

export HELMRYTH_DATA_DIR="$LANE_DIR/profile"
export HELMRYTH_PORT="$CORE_PORT"
export HELMRYTH_UI_PORT="$UI_PORT"

# Keychain is the only credential source. A missing entry is not fatal: the lane
# still boots and the dependent feature simply reports itself unconfigured,
# which is exactly what an unconfigured user sees.
keychain() { security find-generic-password -a helmryth-e2e -s "$1" -w 2>/dev/null; }

OPENAI_KEY="$(keychain helmryth-e2e-openai)"
if [ -n "$OPENAI_KEY" ]; then
  export OPENAI_COMPAT_API_KEY="$OPENAI_KEY"
  export OPENAI_COMPAT_URL="${OPENAI_COMPAT_URL:-https://api.openai.com/v1}"
  export OPENAI_COMPAT_MODEL="${OPENAI_COMPAT_MODEL:-gpt-4o-mini}"
  export OPENAI_COMPAT_PROVIDER="${OPENAI_COMPAT_PROVIDER:-openai}"
  export HELMRYTH_OPENAI_IMAGE_KEY="$OPENAI_KEY"
fi
COMPOSIO_KEY="$(keychain helmryth-e2e-composio)"
[ -n "$COMPOSIO_KEY" ] && export COMPOSIO_API_KEY="$COMPOSIO_KEY"
BOX_KEY="$(keychain helmryth-e2e-box)"
[ -n "$BOX_KEY" ] && export BOX_TOKEN="$BOX_KEY"
TTS_KEY="$(keychain helmryth-e2e-elevenlabs)"
[ -n "$TTS_KEY" ] && export HELMRYTH_TTS_KEY="$TTS_KEY"
AAI_KEY="$(keychain helmryth-e2e-assemblyai)"
[ -n "$AAI_KEY" ] && export ASSEMBLYAI_API_KEY="$AAI_KEY"

# The core runs from SOURCE (node --experimental-strip-types) but the renderer is
# whatever was last built into dist/. Nothing here rebuilds, so a stale dist means
# every lane films a current API behind an old UI — and the footage looks fine.
# That is not hypothetical: film 16-trace shipped four visible "[object Object]"
# rows in the Provider panel it exists to showcase, because it was shot against a
# dist built the previous day, hours before the fix landed in src/lib/inspector.ts.
#
# This asserts rather than builds on purpose. Lanes share one dist/, so a build
# here would swap asset hashes underneath whichever take is mid-recording.
# Rebuild once, deliberately, before a batch: pnpm build
STATIC_ROOT="${HELMRYTH_STATIC_ROOT:-$REPO/dist}"
if [ -f "$STATIC_ROOT/index.html" ]; then
  STALE="$(find "$REPO/src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
    ! -name '*.test.*' -newer "$STATIC_ROOT/index.html" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${STALE:-0}" -gt 0 ]; then
    echo "LANE $LANE REFUSING TO START — the renderer in $STATIC_ROOT is stale."
    echo "  $STALE source file(s) under src/ are newer than the last build."
    echo "  Filming this would record the current API behind an out-of-date UI."
    echo "  Run 'pnpm build' first, or set HELMRYTH_ALLOW_STALE_UI=1 to override."
    [ "${HELMRYTH_ALLOW_STALE_UI:-0}" = "1" ] || exit 1
    echo "  (HELMRYTH_ALLOW_STALE_UI=1 set — proceeding anyway)"
  fi
fi

# The card page must be served from the app's own origin so its webfonts
# resolve. The static host answers unknown paths with the SPA entry, so a
# missing copy here silently screenshots the onboarding screen instead.
cp "$FILM_DIR/titlecard.html" "${HELMRYTH_STATIC_ROOT:-$REPO/dist}/titlecard.html" 2>/dev/null || true

cd "$REPO" || exit 1
# nohup + disown: a lane must outlive the shell that launched it. Without this
# the core dies by SIGHUP the moment the caller's shell exits, which looks
# exactly like a crash — an empty log and a dead pid — halfway through a take.
# The trailing marker is ignored by the server (it reads no argv) and exists so
# a lane core is greppable. Anything sweeping stray servers can then use
# `pkill -f 'server/index.ts' | grep -v helmryth-film-lane` instead of a bare
# `pkill -f server/index.ts`, which kills every concurrent lane at once and
# silently destroys whichever take was mid-recording.
nohup node --experimental-strip-types server/index.ts --helmryth-film-lane="$LANE" > "$LANE_DIR/logs/core.log" 2>&1 &
CORE_PID=$!
echo $CORE_PID > "$LANE_DIR/core.pid"
nohup node "$FILM_DIR/serve.mjs" > "$LANE_DIR/logs/static.log" 2>&1 &
STATIC_PID=$!
echo $STATIC_PID > "$LANE_DIR/static.pid"
disown "$CORE_PID" "$STATIC_PID" 2>/dev/null || true

# Readiness is proven by an actual response from each port, never a fixed sleep.
ready=0
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$CORE_PORT/api/config" \
     && curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$UI_PORT/"; then
    ready=1; break
  fi
  sleep 0.5
done

if [ "$ready" != 1 ]; then
  echo "LANE $LANE FAILED TO START"
  tail -20 "$LANE_DIR/logs/core.log" "$LANE_DIR/logs/static.log"
  exit 1
fi

echo "LANE $LANE READY  ui=http://127.0.0.1:$UI_PORT  core=http://127.0.0.1:$CORE_PORT  dir=$LANE_DIR"
curl -s --max-time 5 "http://127.0.0.1:$CORE_PORT/api/config" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const j=JSON.parse(d);
    const on=(v)=>v&&v.configured?'yes':'no';
    console.log('  providers: openaiCompat='+on(j.openaiCompat)+' composio='+on(j.composio)+' imageGen='+on(j.imageGen)+' box='+on(j.box));
  }catch{console.log('  (config unreadable)');}
});"
