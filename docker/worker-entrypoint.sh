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
DISPLAY_PID=""

start_xorg() {
  echo "Starting Xorg (WORKER_DISPLAY_MODE=xorg) on $DISPLAY, VT 7 ..."
  # Pinned to VT 7 (the conventional "X session" VT) rather than letting
  # Xorg auto-pick -- it defaults to VT 1, which is normally the host's
  # real login console (a getty usually runs there), and fighting the real
  # host console over the same VT is worth avoiding entirely. Needs
  # /dev/tty7 passed through in docker-compose.worker.yml's `devices:`.
  Xorg "$DISPLAY" vt7 -config /app/xorg-worker.conf -noreset -nolisten tcp -novtswitch -sharevts -logfile /tmp/xorg-worker.log &
  DISPLAY_PID=$!
  unset USE_VIRTUALGL
}

start_xvfb() {
  echo "Starting Xvfb + VirtualGL (xvfb-vgl) on $DISPLAY ..."
  Xvfb "$DISPLAY" -screen 0 "${XVFB_RES:-1920x1080x24}" -nolisten tcp -ac &
  DISPLAY_PID=$!
  # Tells lib/danser.js to run danser under `vglrun -d egl` instead of
  # directly -- see the comment there for why this is necessary at all.
  export USE_VIRTUALGL=1
}

wait_for_display() {
  for i in $(seq 1 20); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1
}

# What GLFW itself counts as a monitor: a RandR output that is both
# connected AND has an active CRTC (xrandr prints a WxH+X+Y geometry for
# those; a connected-but-unlit output has none). If Xorg comes up with zero
# such outputs -- real monitor unplugged / powered off / switched to another
# input, with no video=<connector>:D kernel force in place -- GLFW's
# GetPrimaryMonitor() returns nil and danser dies on every single job with
# "panic: invalid memory address or nil pointer dereference" in
# (*Monitor).GetVideoMode, right after "GLFW Initialized!". The X server
# being *up* is not enough.
xorg_has_monitor() {
  xrandr --query 2>/dev/null | grep -Eq ' connected( primary)? [0-9]+x[0-9]+\+'
}

stop_display() {
  kill "$DISPLAY_PID" 2>/dev/null || true
  wait "$DISPLAY_PID" 2>/dev/null || true
  # A cleanly-terminated X server removes these itself; sweep anyway so a
  # slow/unclean exit can't block the replacement server on the same number.
  n="${DISPLAY#:}"
  rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
}

cleanup() {
  kill "$DISPLAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

if [ "$DISPLAY_MODE" = "xorg" ]; then
  start_xorg
  if ! wait_for_display; then
    echo "FATAL: xorg display server never came up on $DISPLAY."
    echo "--- /tmp/xorg-worker.log ---"
    cat /tmp/xorg-worker.log 2>/dev/null || echo "(no log file)"
    exit 1
  fi
  if ! xorg_has_monitor; then
    echo "WARNING: Xorg is up on $DISPLAY but has NO connected, active output:"
    xrandr --query 2>&1 | sed 's/^/  /' || true
    echo "WARNING: danser cannot run against a monitor-less X server (GLFW has no primary monitor)."
    echo "WARNING: Falling back to xvfb-vgl so the worker stays in service (slower for libx264 -- see CLAUDE.md Session 6)."
    echo "WARNING: To get xorg mode back: reconnect/power on the monitor on the GPU's output (or force the connector"
    echo "WARNING: with a video=<connector>:D kernel boot param), then restart this container."
    stop_display
    DISPLAY_MODE="xvfb-vgl"
    start_xvfb
  fi
else
  start_xvfb
fi

if ! wait_for_display; then
  echo "FATAL: $DISPLAY_MODE display server never came up on $DISPLAY."
  exit 1
fi

# The mode actually in effect (differs from WORKER_DISPLAY_MODE after the
# fallback above) -- worker.js uses it to pick the right per-job health check.
export WORKER_EFFECTIVE_DISPLAY_MODE="$DISPLAY_MODE"

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
