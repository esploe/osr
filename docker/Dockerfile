# syntax=docker/dockerfile:1

############################
# Stage 0: version info    #
############################
# Deliberately its own stage, independent of danser-build below -- if this
# lived inside danser-build, COPYing .git (which changes every commit) would
# invalidate that stage's cache and force a full danser-go re-clone/rebuild
# on every single deploy instead of just when DANSER_REF/Dockerfile change.
FROM node:20-bookworm-slim AS gitinfo
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY .git ./.git
RUN git rev-parse --short HEAD > /version.txt 2>/dev/null || echo "unknown" > /version.txt

############################
# Stage 1: build danser-go #
############################
FROM golang:1.24-bookworm AS danser-build

# danser-go uses go-gl/glfw (cgo) for its GL/window bindings, so it needs
# the usual GLFW native build deps even though we only ever run it headless
# against Xvfb -- GLFW still needs real X11 client libs to link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config \
    libgl1-mesa-dev libx11-dev libxcursor-dev libxrandr-dev libxinerama-dev libxi-dev libxxf86vm-dev libxkbcommon-dev \
    libgtk-3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Pinned to the exact danser-go commit the split-encode patch below was
# generated against -- the patch is applied with `git apply` right after
# this clone, so building against a moved `master` would make it fail to
# apply and break the build. Override with --build-arg DANSER_REF=<tag/commit>
# only together with a patch regenerated against that ref.
ARG DANSER_REF=8331b0ffb841cc9e0f5e6b756bcf2bba2a9465c0
RUN git clone https://github.com/Wieku/danser-go.git . && git checkout ${DANSER_REF}

# EXPERIMENTAL (rendering-speed investigation, see CLAUDE.md Session 12):
# split-encode patch. The timing-probe instrumentation that led here
# (mainLoopRecord's per-frame closure is ~65% dominated by MakeFrame()'s
# freePBOPool wait, which traces to ffmpeg's own CPU-bound x264 encode
# saturating the worker's 4 cores -- not anything in danser's
# render/readback path) has been removed now that its job is done; see
# docker/patches/split-encode.patch and CLAUDE.md for the full diagnosis.
# This patch adds Recording.SplitEncode/SplitEncoderName/
# SplitEncoderCustomOptions/SplitEncoderFilters/SplitRatio: when enabled,
# danser renders each frame once then routes contiguous ~5s chunks
# round-robin between the primary (e.g. CPU libx264) and a second,
# concurrently-running ffmpeg encoder (e.g. GPU VAAPI), each chunk its own
# file, concatenated in order before the existing audio mux -- letting two
# mostly-independent hardware resources encode at once instead of one
# sitting idle. Measured ~17% faster at 1080p60 (see Session 12), gated on
# SPLIT_ENCODE_EXPERIMENT in lib/danserSettings.js so the default build is
# stock danser. Generated against danser-go commit
# 8331b0ffb841cc9e0f5e6b756bcf2bba2a9465c0 -- if DANSER_REF drifts past this
# and the patch stops applying cleanly, pin DANSER_REF to that commit (or
# regenerate the patch) rather than debugging a stale diff.
COPY docker/patches/split-encode.patch /tmp/split-encode.patch
RUN git apply /tmp/split-encode.patch

# Rendering-speed investigation (see CLAUDE.md, Session 5): danser's own
# mainLoopRecord() (app/app.go) processes every frame through one blocking
# closure -- game update, draw calls, and MakeFrame()'s readback kickoff --
# with no thread preparing frame N+1 while frame N drains. The author's own
# comment on checkData() (app/ffmpeg/video.go) says they tried moving this
# to another goroutine and hit real OpenGL context-affinity problems, so
# this isn't a naive oversight to "just fix". MakeFrame() only blocks
# (gl.ClientWaitSync) when the free-PBO pool (MaxVideoBuffers = 10) is
# fully exhausted -- tried widening it to 60 on the theory that this
# backpressure valve was the dominant stall; measured *worse* (608s vs the
# 537s stock baseline, near-identical GPU busy%), so that theory doesn't
# hold and the patch was reverted. Left as a comment, not a live change,
# so the next session doesn't have to re-derive or re-test this.

# Matches the repo's own documented build path (README "Building and
# running the project"): a plain `go build` from the repo root, which
# fetches its Go deps automatically. The resulting binary handles both the
# GUI launcher and CLI/record mode from one executable, branching on
# whether any flags were passed (see main.go) -- we always pass flags, so
# it always takes the CLI path.
RUN go build -o /out/danser .

############################
# Stage 2: runtime image   #
############################
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    xvfb x11-utils x11-xserver-utils \
    libgl1 libglx-mesa0 libegl1 libgbm1 mesa-utils \
    libx11-6 libxcursor1 libxrandr2 libxinerama1 libxi6 libxxf86vm1 libxkbcommon0 \
    libgtk-3-0 \
    ca-certificates fonts-noto \
    wget \
    # libva2/libva-drm2 are the VAAPI runtime; mesa-va-drivers is the actual
    # driver *plugin* libva loads for AMD (and Intel) GPUs (radeonsi_drv_video.so)
    # -- without it libva has a runtime but nothing to talk to the GPU with,
    # which is exactly the "unknown libva error" / "Device creation failed"
    # failure this was missing before. vainfo is just for diagnostics.
    libva2 libva-drm2 mesa-va-drivers vainfo \
    # For the worker's opt-in WORKER_DISPLAY_MODE=xorg path (see
    # docker/worker-entrypoint.sh) -- a real Xorg server against the amdgpu
    # DDX driver, bypassing VirtualGL entirely. Unused (but harmless/idle)
    # in the coordinator's software-only container and the worker's default
    # xvfb-vgl mode.
    xserver-xorg-core xserver-xorg-video-amdgpu \
    && rm -rf /var/lib/apt/lists/*

# Xorg.wrap (xserver-xorg-core's setuid launcher) refuses to start Xorg
# unless the invoking user owns the active console tty by default -- there
# is no real console session in a container, so that check always fails
# here. We always run as root anyway, so disabling it is safe.
RUN mkdir -p /etc/X11 && printf 'allowed_users=anybody\nneeds_root_rights=yes\n' > /etc/X11/Xwrapper.config

# VirtualGL: Xvfb alone only ever does software (llvmpipe) OpenGL -- GLFW
# 3.3 (what danser uses) only speaks GLX on Linux, with no EGL-headless
# option, so it always renders through whatever X display DISPLAY points
# at. VirtualGL's EGL back end intercepts those GLX calls and redirects the
# actual rendering to a real GPU via its DRI device directly, independent
# of Xvfb having no GPU support of its own. This only matters for the
# worker (see docker/worker-entrypoint.sh) -- the coordinator stays
# software-only and never invokes vglrun.
ARG VIRTUALGL_VERSION=3.1.4
RUN wget -q "https://github.com/VirtualGL/virtualgl/releases/download/${VIRTUALGL_VERSION}/virtualgl_${VIRTUALGL_VERSION}_amd64.deb" -O /tmp/virtualgl.deb \
    && (dpkg -i /tmp/virtualgl.deb || (apt-get update && apt-get install -y -f --no-install-recommends)) \
    && rm -f /tmp/virtualgl.deb && rm -rf /var/lib/apt/lists/*

COPY --from=danser-build /out/danser /app/danser/danser
# danser reads its assets (fonts, textures, shaders) from disk relative to
# the executable's directory rather than embedding them via go:embed --
# tools/assets/assets.go only packs them for the official zipped release,
# which we're not using.
COPY --from=danser-build /src/assets /app/danser/assets
# BASS (audio) and libyuv (video scaling) are vendored as prebuilt shared
# libraries in the repo itself (proprietary BASS license forbids anything
# else) and must sit next to the binary, exactly like the upstream
# dist-linux.sh release build does.
COPY --from=danser-build /src/libbass.so /src/libbass_fx.so /src/libbassmix.so /src/libyuv.so /app/danser/

COPY docker/asound.conf /etc/asound.conf
COPY docker/entrypoint.sh /app/entrypoint.sh
COPY docker/worker-entrypoint.sh /app/worker-entrypoint.sh
COPY docker/xorg-worker.conf /app/xorg-worker.conf
RUN chmod +x /app/entrypoint.sh /app/worker-entrypoint.sh

WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/src ./src
COPY web /app/web
COPY --from=gitinfo /version.txt /app/VERSION.txt

ENV DANSER_BIN=/app/danser/danser
ENV WEB_DIR=/app/web
ENV DATA_DIR=/data
VOLUME /data

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
