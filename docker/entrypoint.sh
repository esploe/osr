#!/usr/bin/env bash
set -euo pipefail

# --- Persist danser's stateful files in the /data volume -------------------
# danser resolves its config/db directory relative to its own executable
# path (see framework/env.Init), which lives in the image, not the /data
# volume. Symlink the two stateful bits it writes -- the settings/ dir and
# its beatmap index db -- into /data so they survive container restarts
# instead of re-scanning/re-generating from scratch every time.
mkdir -p /data/danser-settings /data/songs /data/skins /data/uploads /data/output
[ -e /app/danser/settings ] || ln -s /data/danser-settings /app/danser/settings
[ -e /app/danser/danser.db ] || ln -s /data/danser.db /app/danser/danser.db

# --- Virtual display for headless software OpenGL -------------------------
export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 "${XVFB_RES:-1920x1080x24}" -nolisten tcp -ac &
XVFB_PID=$!

# Force Mesa's software rasterizer (llvmpipe) -- there's no real GPU in this
# container, and this avoids danser-go trying (and failing) to pick up a
# hardware driver / DRI device that doesn't exist.
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe

# danser-go still initializes an audio backend even when only recording to
# a file; there's no real sound card in the container, so point ALSA at a
# null device instead of letting it fail to open one.
export ALSA_CARD=Dummy
export SDL_AUDIODRIVER=dummy

cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Give Xvfb a moment to come up before anything tries to connect to it.
for i in $(seq 1 20); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

exec node /app/server/src/index.js
