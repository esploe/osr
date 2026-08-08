#!/usr/bin/env bash
set -euo pipefail

# --- Persist danser's stateful files in the /data volume -------------------
# Same reasoning as docker/entrypoint.sh -- symlink danser's settings dir
# and beatmap index db into the (worker-local) /data volume so they survive
# container restarts.
mkdir -p /data/danser-settings /data/songs /data/skins /data/uploads /data/output
[ -e /app/danser/settings ] || ln -s /data/danser-settings /app/danser/settings
[ -e /app/danser/danser.db ] || ln -s /data/danser.db /app/danser/danser.db

# --- Virtual display -------------------------------------------------------
# Still needed for GLFW to have *an* X server to talk to (window management
# / input only) -- but Xvfb itself never does hardware-accelerated GLX, so
# it does NOT determine which GPU driver actually renders frames. Real
# rendering is redirected to the GPU by VirtualGL (see USE_VIRTUALGL below
# and lib/danser.js), independent of what Xvfb is capable of.
export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 "${XVFB_RES:-1920x1080x24}" -nolisten tcp -ac &
XVFB_PID=$!

# No real sound card here either -- same null-device rationale as the
# coordinator entrypoint.
export ALSA_CARD=Dummy
export SDL_AUDIODRIVER=dummy

# Tells lib/danser.js to run danser under `vglrun -d egl` instead of
# directly -- see the comment there for why this is necessary at all.
export USE_VIRTUALGL=1

cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 20); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

echo "Renderer GL device check (plain, against Xvfb -- expected to say llvmpipe, this is NOT what rendering actually uses):"
DISPLAY="$DISPLAY" glxinfo -B 2>&1 | grep -E "OpenGL renderer|OpenGL version" || echo "  (glxinfo unavailable or failed)"

echo "Renderer GL device check (via VirtualGL EGL back end -- this IS what rendering actually uses):"
DISPLAY="$DISPLAY" vglrun -d egl glxinfo -B 2>&1 | grep -E "OpenGL renderer|OpenGL version" || echo "  (vglrun+glxinfo failed -- check the full output above for errors, GPU rendering will likely fail too)"

exec node /app/server/src/worker.js
