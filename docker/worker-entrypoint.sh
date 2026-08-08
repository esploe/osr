#!/usr/bin/env bash
set -euo pipefail

# --- Persist danser's stateful files in the /data volume -------------------
# Same reasoning as docker/entrypoint.sh -- symlink danser's settings dir
# and beatmap index db into the (worker-local) /data volume so they survive
# container restarts.
mkdir -p /data/danser-settings /data/songs /data/skins /data/uploads /data/output
[ -e /app/danser/settings ] || ln -s /data/danser-settings /app/danser/settings
[ -e /app/danser/danser.db ] || ln -s /data/danser.db /app/danser/danser.db

# No real sound card here either -- same null-device rationale as the
# coordinator entrypoint.
export ALSA_CARD=Dummy
export SDL_AUDIODRIVER=dummy

export DISPLAY="${DISPLAY:-:99}"

# --- Display backend ---------------------------------------------------
# xvfb-vgl (default, proven): Xvfb -- which never does hardware-accelerated
# GLX at all -- plus VirtualGL's EGL back end bridging danser's GLX calls to
# the real GPU. Every frame pays for a GPU->Xvfb frame-transport copy on top
# of danser's own pixel readback -- suspected dominant cost behind the
# ~0.85x realtime ceiling measured so far (see CLAUDE.md).
#
# xorg (opt-in, NOT YET LIVE-VERIFIED): a real Xorg server bound to the
# amdgpu driver, talking to the GPU's actual display output directly --
# danser's GLX calls go straight to Xorg, straight to the GPU, no
# VirtualGL/bridging in the loop at all. Requires a connector the kernel
# reports as "connected" (the video=<connector>:D boot param set up on this
# VM) -- Xorg won't set up a screen on an output the kernel still shows
# disconnected. Real-GPU-Xorg-in-a-container has known rough edges (DRM
# master access, VT/tty handling) that can't be fully verified without
# running it on the actual box, hence this being an explicit opt-in rather
# than replacing xvfb-vgl outright -- a failed Xorg start below exits this
# script non-zero, which crash-loops the container, so if that happens
# roll back by unsetting WORKER_DISPLAY_MODE (or setting it back to
# xvfb-vgl) rather than debugging blind against a dead worker.
DISPLAY_MODE="${WORKER_DISPLAY_MODE:-xvfb-vgl}"

if [ "$DISPLAY_MODE" = "xorg" ]; then
  echo "Starting Xorg (WORKER_DISPLAY_MODE=xorg) on $DISPLAY ..."
  Xorg "$DISPLAY" -config /app/xorg-worker.conf -noreset -nolisten tcp -novtswitch -sharevts -logfile /tmp/xorg-worker.log &
  DISPLAY_PID=$!
  unset USE_VIRTUALGL
else
  echo "Starting Xvfb + VirtualGL (WORKER_DISPLAY_MODE=xvfb-vgl, the default) on $DISPLAY ..."
  Xvfb "$DISPLAY" -screen 0 "${XVFB_RES:-1920x1080x24}" -nolisten tcp -ac &
  DISPLAY_PID=$!
  # Tells lib/danser.js to run danser under `vglrun -d egl` instead of
  # directly -- see the comment there for why this is necessary at all.
  export USE_VIRTUALGL=1
fi

cleanup() {
  kill "$DISPLAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 20); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "FATAL: $DISPLAY_MODE display server never came up on $DISPLAY."
  if [ "$DISPLAY_MODE" = "xorg" ]; then
    echo "--- /tmp/xorg-worker.log ---"
    cat /tmp/xorg-worker.log 2>/dev/null || echo "(no log file)"
  fi
  exit 1
fi

if [ "$DISPLAY_MODE" = "xorg" ]; then
  echo "Renderer GL device check (native Xorg, no VirtualGL -- this IS what rendering actually uses):"
  DISPLAY="$DISPLAY" glxinfo -B 2>&1 | grep -E "OpenGL renderer|OpenGL version" || echo "  (glxinfo failed -- GPU rendering will likely fail too, check /tmp/xorg-worker.log)"
else
  echo "Renderer GL device check (plain, against Xvfb -- expected to say llvmpipe, this is NOT what rendering actually uses):"
  DISPLAY="$DISPLAY" glxinfo -B 2>&1 | grep -E "OpenGL renderer|OpenGL version" || echo "  (glxinfo unavailable or failed)"

  echo "Renderer GL device check (via VirtualGL EGL back end -- this IS what rendering actually uses):"
  DISPLAY="$DISPLAY" vglrun -d egl glxinfo -B 2>&1 | grep -E "OpenGL renderer|OpenGL version" || echo "  (vglrun+glxinfo failed -- check the full output above for errors, GPU rendering will likely fail too)"
fi

exec node /app/server/src/worker.js
