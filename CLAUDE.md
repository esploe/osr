# osu! replay → video renderer — project context

Self-hosted, o!rdr-style tool: upload an osu! `.osr` replay (or paste a score
URL), pick render options in a web UI, get back an MP4. Rendering is done by
[danser-go](https://github.com/Wieku/danser-go); encoding by ffmpeg (CPU
libx264/libx265, or AMD VAAPI hardware encode). See [README.md](README.md)
for user-facing setup docs — this file is for picking development back up,
not end-user instructions.

## Current live deployment (as of this writing)

This is **not** a single-machine setup anymore. Three real machines on the
same LAN (192.168.10.0/24):

| Role | Host | Notes |
|---|---|---|
| Coordinator (web UI + job queue) | `192.168.10.118` | SSH user `docker`. Runs `docker-compose.yml`. Also reachable at `https://osr.plose.dev`. |
| Render worker (GPU) | `192.168.10.115` | SSH user `jellyfin`. Runs `docker-compose.worker.yml`. Proxmox VM with an AMD RX 570 (Polaris) passed through via VFIO. `jellyfin` is not in the `docker` group, but has **passwordless sudo** as of the rendering-speed Session 3 investigation (`/etc/sudoers.d/jellyfin-nopasswd`, `NOPASSWD:ALL`) -- set up specifically so profiling/GRUB/container-restart work could be scripted; worth knowing this is a fairly broad grant if revisiting worker security later. A real monitor is now physically connected to the worker's GPU via HDMI (previously headless). |
| Zipline (upload target) | `192.168.10.117` / `srx.plose.dev` | User's own instance, app port `3000` on the LAN, also reverse-proxied through Cloudflare for the public domain. |

There's also a **local dev copy** on the Windows machine this was built from
(`docker-compose.yml`, plain `docker compose up`, `RENDER_MODE=local`) --
useful for testing code changes before pushing to `.118`/`.115`, but it is
not part of the real deployment.

### Redeploy procedure

The project now has a real (public) remote: `https://github.com/esploe/osr.git`
on branch `main`. Both `.118` and `.115` have their own clone at
`~/osu-replay-renderer` (moved off the old `/tmp/osu-replay-renderer`
tar-drop location -- `/tmp` isn't durable across reboots, which matters
once the checkout is a real git working tree). The old tar-over-ssh
procedure is retired; don't resurrect it unless the GitHub remote itself
becomes unreachable.

**Important:** Compose derives its project name (and therefore which
containers/named volumes a deploy attaches to) from the checkout
directory's *basename*. Both clones must be named `osu-replay-renderer`
-- a differently-named clone would spin up a second, empty-volume
deployment side-by-side instead of updating the existing one.

From the dev machine, same as any repo: commit, then `git push`.

On each VM:
```bash
cd ~/osu-replay-renderer && git pull
```
```bash
docker compose up --build -d                                    # coordinator (.118)
```
```bash
sudo docker compose -f docker-compose.worker.yml up --build -d  # worker (.115), needs sudo
```

`.env` is gitignored and was copied over once by hand when each clone was
first set up (from the old `/tmp/osu-replay-renderer/.env`) -- it isn't
touched by `git pull`, so new `.env.example` keys added later need to be
added to each host's real `.env` manually.

The web UI shows a build-version badge (top-right, short git commit hash,
via `docker/Dockerfile`'s `gitinfo` stage -> `/api/config`'s `version`
field) specifically so a stale deploy is visible at a glance instead of
having to guess whether `git pull` + rebuild actually landed.

## Architecture

- **Coordinator** (`server/src/index.js` + `routes/*`): Express app, web UI
  (`web/`), job queue (`lib/jobQueue.js`), does replay parsing
  (`lib/osrParser.js`) and beatmap mirror resolution/download
  (`lib/beatmapMirror.js`) itself regardless of render mode.
- **Rendering** happens either locally (`lib/danser.js` invoked directly) or
  on a remote worker, controlled by `RENDER_MODE` (`local` | `worker`).
  `lib/renderPipeline.js` branches on this right before the render step.
- **Worker** (`server/src/worker.js`): separate entrypoint, same Docker
  image, different role. Polls `GET /api/internal/jobs/next` on the
  coordinator, downloads the replay + beatmap + skin (as zips, via
  `routes/internal.js`), renders locally with the *same* `lib/danser.js` /
  `lib/danserSettings.js` code the coordinator would use, uploads the
  result back via `POST /api/internal/jobs/:id/result`. All
  `/api/internal/*` routes are gated by a shared-secret `WORKER_TOKEN`
  header.
- **Settings**: `lib/settingsSchema.js` is the single source of truth for
  every exposed option (frontend builds its form from `GET /api/config`,
  which just serializes this). `lib/danserSettings.js` maps those UI values
  onto danser's real `settings.json` shape. **Never hand-author danser's
  settings.json** -- `lib/danser.js#ensureBaseSettings()` bootstraps a real
  one by running danser itself with no beatmap args (it writes
  `settings/base.json` and exits cleanly before touching GLFW/OpenGL at
  all), and everything else deep-clones + patches that. This was
  deliberate: danser's settings shape has been verified against the actual
  generated file, not guessed from source reading alone.
- **Profiles** (`lib/profiles.js` + `routes/profiles.js`): named settings
  presets, stored as one JSON file in the coordinator's data dir. Coordinator-only concept, nothing worker-side.

## Rendering pipeline internals (the hard-won parts)

- danser-go only speaks GLX on Linux (GLFW 3.3, no headless/EGL mode), so
  it always needs *some* X display. The coordinator forces Mesa's software
  rasterizer (`LIBGL_ALWAYS_SOFTWARE=1`/`GALLIUM_DRIVER=llvmpipe`,
  set in `docker/entrypoint.sh`) since it has no GPU. **This env var
  forcing must stay in the entrypoint script, not in `lib/danser.js`** --
  it was briefly hardcoded into the shared `runDanser()` spawn env and that
  silently forced software rendering on the GPU worker too. `lib/danser.js`
  now just inherits `process.env` unmodified and trusts whichever
  entrypoint script set (or didn't set) those vars.
- The worker has a real GPU but still needs an X display for GLFW, and
  Xvfb (`docker/worker-entrypoint.sh`) is *software-only* -- it has no
  hardware GL path at all. **VirtualGL** (`vglrun -d egl`, installed via
  the official `.deb` in the Dockerfile) bridges this: it intercepts GLX
  calls and redirects actual rendering to the GPU's DRI device
  (`/dev/dri/renderD128`, passed through via `docker-compose.worker.yml`'s
  `devices:`), independent of Xvfb. Controlled by `USE_VIRTUALGL=1`
  (worker entrypoint only) which `lib/danser.js#runDanser()` checks to
  decide whether to wrap the danser invocation in `vglrun`.
- **VAAPI hardware encode** (`videoCodec: "h264_vaapi"` in the schema):
  danser has no built-in VAAPI preset, so `lib/danserSettings.js` sets
  `Recording.Encoder` to the raw string `"h264_vaapi"`, which danser's own
  `GetEncoderOptions()` switch falls through to `Recording.custom` for --
  we set `Recording.custom.CustomOptions = "-vaapi_device
  /dev/dri/renderD128 -qp <crf>"` and `Recording.PixelFormat = "nv12"` +
  `Recording.Filters = "hwupload"` (danser does the RGB→NV12 conversion
  itself on the GPU via its own shader-based converter when PixelFormat is
  nv12, avoiding an extra CPU-side ffmpeg `format=nv12` pass). Confirmed
  working live via a standalone ffmpeg test on the actual worker hardware
  before wiring it in. Requires `mesa-va-drivers`/`libva2`/`libva-drm2` in
  the runtime image (the actual VAAPI *driver plugin* for AMD --
  `libgl1`/`libegl1` alone are not enough; this was a real missing-package
  bug that produced a generic "unknown libva error").

### Rendering speed investigation (exhausted the cheap levers -- read this before trying again)

**Bottom line, as of this writing: ~0.85-0.94x realtime on the RX 570
worker, regardless of which of the below is tried.** Every low-risk,
config/environment-level lever has now been tested and ruled out. A real
fix from here means either actual GPU profiling tooling (not available in
this environment) or real Go changes to danser-go's internals, with no
guarantee of payoff. Don't re-try any of the ruled-out items below without
new evidence -- this list is the accumulated result of a full day's
investigation, not a guess.

**Confirmed NOT the bottleneck (all tested live, in this order):**

1. **Encoder/pixel-format choice** -- CPU (llvmpipe) and GPU+VAAPI both
   land at the same ~0.8-0.92x; switching didn't move the needle.
2. **Resolution is NOT irrelevant** -- lowering it gave a genuine ~4x
   speedup, proving the cost is throughput-bound (proportional to pixel
   count), not a fixed per-frame latency. This is the one lever that
   *does* work, it's just a quality tradeoff, not a fix.
3. **VirtualGL's GPU->Xvfb frame-transport bridging.** Originally the
   leading theory (and why o!rdr's own client refuses to run without a
   real physical display -- see `MasterIO02/ordr-client` -- avoiding this
   exact bridging). Tested by getting danser to render *natively* against
   a real Xorg server with zero VirtualGL in the loop (see "Xorg native
   rendering path" below) -- **result: identical speed.** This ruled out
   the bridging as the dominant cost, contrary to the original hypothesis.
4. **Naive/blocking pixel readback.** Read danser-go's actual source
   (`app/ffmpeg/video.go`) expecting to find a synchronous
   `glReadPixels`-and-block pattern that a double-buffered PBO patch could
   fix cheaply. It's already far more sophisticated than that: a
   `MaxVideoBuffers = 10` pool of persistent-mapped PBOs, `FenceSync` +
   non-blocking `gl.Flush()` per frame, and a separate goroutine draining
   completed frames to the ffmpeg pipe. The "add async readback" fix does
   not exist to be made -- it's already there.
5. **An artificial FPS cap.** `settings.Recording.EncodingFPSCap` could in
   principle throttle rendering to exactly the target output fps, which
   would make ~0.9x meaningless as a "how fast could this go" measurement.
   Checked danser-go's source: defaults to `0` (uncapped,
   `frame.Limiter.Sync()` is a no-op at `fps <= 0`), and this project never
   sets it. Ruled out.
6. **GPU power-state/DPM scaling.** The GPU's `gpu_busy_percent` oscillates
   sharply between 0 and 100 during rendering -- looked like confirmation
   of a serialized render/readback pipeline at first, until the user noted
   **this GPU has always oscillated like this, even pre-Proxmox, suspected
   firmware/voltage issue.** Tested directly: forced
   `power_dpm_force_performance_level=high` (pins the clock at its top
   state, 1284MHz, confirmed via `pp_dpm_sclk`, disabling dynamic
   scaling) -- **the 0/100 oscillation persisted identically, and render
   speed was unchanged (still 0.22x at 1440p144).** Rules out DPM/clock
   scaling as the cause of either the oscillation or the speed ceiling.

**What the oscillation most likely is, given all of the above:** not a
power-management artifact (ruled out #6), not blocking readback (ruled
out #4) -- most likely genuine bursty GPU/CPU handoff in danser's main
render loop itself: the *readback* is pipelined/async, but nothing found
so far suggests danser pipelines the *rendering* of frame N+1 while frame
N is still being processed by the GPU. **This is now confirmed with real
profiling data, not just inferred -- see "Session 2" below.**

### Session 2: real profiling data (confirms the pipelining hypothesis)

`radeontop` turned out to already be installed on the worker (`.115`,
pre-existing, presumably from whatever else that box is used for --
it's also running a native `jellyfin` media server, hence the `jellyfin`
SSH user) and needs no `sudo`: the `jellyfin` account is in the `video`
and `render` groups, which is enough for both `radeontop` and reading
`/sys/.../gpu_busy_percent` directly. `mpstat`/`pidstat` are **not**
installed and installing them needs `apt-get` via `sudo`, which needs an
interactive password on this box -- worked around by sampling
`/proc/<pid>/stat` (`utime`+`stime` fields) directly once a second
instead, which is world-readable regardless of process owner and needs
no privilege at all.

Test: real render via the coordinator's `Score URL` path, using the
existing "quality 1440p144hz" profile (2560x1440@144, VAAPI h264) against
a 136.638s replay -- i.e. the same class of workload as the "0.22x at
1440p144" figure in item 6 above. Captured `radeontop -d - -i 0.5` and
the `/proc` CPU sampler for the entire render (danser start to danser
exit, ~537s wall time for 136.6s of content = **~0.25x realtime**,
consistent with the earlier 0.22x reading on the same settings).

**Results (538 GPU samples, 338 CPU samples, full render duration):**
- **GPU busy%: mean 36.6%, min 0%, max 45.8%, 99% of all samples fall in
  the 25-50% band.** No sample anywhere near 100%, and the earlier
  "sharply oscillates between 0 and 100" description does not reproduce
  under `radeontop`'s own sampling -- most likely that description came
  from reading raw `gpu_busy_percent` in a tight instantaneous loop
  (which really can read as binary 0/100 depending on exactly when the
  kernel's own counter last updated), whereas `radeontop` does its own
  internal smoothing. Both readings agree on the conclusion that matters:
  **the GPU is idle roughly 2/3 of the time.**
- **CPU: danser process mean 42% of one core (max 61%); the VAAPI-feeding
  ffmpeg process mean 23% (max 31%); the audio-encode ffmpeg process
  ~1.5%.** The worker VM has 4 cores. Nothing here is remotely close to
  saturating even a single core, let alone all 4.
- **Conclusion: neither the GPU nor any CPU-bound stage is saturated.**
  That rules out both "GPU compute-bound" and "CPU compute-bound" as the
  explanation for the ~0.25x speed -- if either were the true bottleneck,
  that resource's utilization would sit near 100%. Instead, wall-clock
  time is being lost to **synchronization/latency overhead between
  stages** (GPU render -> readback -> CPU-side packaging -> ffmpeg pipe
  -> encode), each one idling while waiting on the other, rather than
  frame N+1 being prepared/rendered while frame N is still in flight
  through readback/encode. This is exactly the "no frame-ahead
  pipelining" hypothesis from Session 1 -- now backed by numbers instead
  of being the leading guess.
- **Caveat:** danser-go is not vendored in this repo -- `docker/Dockerfile`
  clones it fresh from `https://github.com/Wieku/danser-go.git` at build
  time (pinned via the `DANSER_REF` build-arg, defaults to `master`). Any
  render-loop pipelining fix means forking upstream and pointing
  `DANSER_REF` at the fork/branch (or maintaining a patch applied during
  the Docker build), not an in-repo edit.

### Session 3: real physical monitor, real Xorg -- still not the fix

Motivation: the leading historical theory for *why* danser might be slow
in this setup specifically (as opposed to some inherent danser-go limit)
was always "no real display" -- it's explicitly why o!rdr's own render
client (`MasterIO02/ordr-client`) refuses to run headless. Session 1's
Xorg test (see below) seemed to rule this out, but that test used a
**software-forced** "connected" state (`video=HDMI-A-1:D`) with no actual
monitor -- not proof a *genuinely* scanned-out display behaves the same.
The user later physically ran an HDMI cable from the worker's GPU to a
real monitor, which made it possible to close that gap properly.

Procedure (all live on `.115`):
1. Removed `video=HDMI-A-1:D` from `/etc/default/grub`, `update-grub`,
   rebooted. Confirmed the fix mattered: before, `HDMI-A-1` reported
   `connected` with a real 256-byte EDID but only a `640x480` fallback
   mode (the force flag was short-circuiting real EDID-based mode
   enumeration even though a real monitor was attached). After reboot,
   same connector reports the monitor's full real mode list up to 4K --
   confirming genuine EDID negotiation, not the old software force.
2. Flipped `.env`'s `WORKER_DISPLAY_MODE` to `xorg`, rebuilt/restarted the
   worker container. Container log confirmed
   `Renderer GL device check (native Xorg, no VirtualGL...)` ->
   `AMD Radeon RX 570 Series (polaris10, ...)`, i.e. genuinely native
   rendering against the real display, not a repeat of the fake-connector
   test.
3. Re-ran the identical test from Session 2 (same score URL, same
   "quality 1440p144hz" profile, same `radeontop` capture method).

**Result: 646s wall time vs Session 2's 537s -- the real monitor was**
**~17% *slower*, not faster (~0.21x realtime vs ~0.25x).** GPU busy% mean
was actually *higher* this run (42.7% vs 36.6%, still capped at 50%,
still nowhere near saturated) -- higher utilization *and* slower
completion together are consistent with the real monitor adding a new,
constant GPU cost that wasn't there before (continuously scanning out the
framebuffer to actual physical output at the negotiated refresh rate,
which `Xvfb` never has to do since it drives no real output), not with
removing the Session 2 synchronization bottleneck. (Caveat: the
`/proc`-based CPU sampler for this run had a script bug and returned a
constant 0% for the whole capture -- a data-collection bug, not a real
reading -- so there's no danser-CPU comparison for this run, only wall
time and GPU busy%, both of which came from working instrumentation.)

**Conclusion: "needs a real display" does not explain this project's**
**speed gap to o!rdr.** The Session 2 synchronization-overhead diagnosis
stands even with a genuine physical monitor attached. Closing the gap to
o!rdr's actual throughput is more likely explained by them running
substantially stronger render-node hardware and/or a different/patched
render pipeline, not by anything specific to headless vs. physical-display
rendering in this project's danser-go integration.

### Session 4: VAAPI encode is a regression, not a speedup (at least as wired up here)

Motivation: the user measured **1.4x realtime** using this project's
*default* settings (1080p60, `libx264` CPU encode) -- notably faster than
the ~0.9-1.07x that pure pixel-count scaling from the Session 2/3
1440p144-VAAPI baseline would predict. Worth checking properly, because
Session 1's original "encoder doesn't matter" conclusion (item 1) never
actually isolated the encoder as a variable -- it compared *CPU software
rendering* (llvmpipe, coordinator) against *GPU rendering + VAAPI encode*
(worker), i.e. two different machines and two changed variables at once.
It never tested "GPU renders, CPU encodes" vs "GPU renders, GPU encodes"
on the *same* hardware.

Test: identical replay/beatmap, identical `1920x1080@60` settings, worker
still in Xorg mode from Session 3 -- only `videoCodec` changed
(`libx264` vs `h264_vaapi`), radeontop capture both runs.

| | 1080p60, libx264 (CPU) | 1080p60, VAAPI (GPU) |
|---|---|---|
| Wall time | 129s | 146s |
| Realtime multiplier | **1.06x** | **0.94x** |
| GPU busy% mean | **53.3%** | **19.4%** |
| GPU busy% max | 70.8% | 26.7% |

**CPU encode is ~13% faster *and* the GPU is nearly 3x busier doing it** --
despite the GPU doing *less* total work (render only, vs. render+encode
for VAAPI). More work, lower utilization, slower wall time: that pattern
means the VAAPI path isn't just "competing with rendering for the GPU
engine" (which would predict *higher* busy% while slower) -- it's actively
introducing **synchronization stalls that leave the GPU idle more often**,
not less. This likely traces to how VAAPI had to be wired up in the first
place (see "VAAPI hardware encode" above): danser has no built-in VAAPI
preset, so this project bolts it on via a raw `Recording.custom
.CustomOptions` string + `hwupload` filter rather than a native encoder
path -- plausibly a less efficient handoff than a first-class integration
would be.

**Conclusion: VAAPI hardware encode is currently a regression, not a**
**speedup, in this pipeline** -- at least at 1080p60 with GPU-side
rendering. This is separate from (and doesn't contradict) the core Session
2/3 "no frame-ahead pipelining" diagnosis: even the *faster* CPU-encode
path here only hit 53% GPU busy, still nowhere near saturated. Worth
treating "should the worker even use VAAPI" as its own open question
alongside the deeper render-loop fix -- and a much cheaper one to revisit,
since it doesn't require forking danser-go, just investigating whether the
custom `hwupload`/VAAPI wiring can avoid whatever's causing the stalls.

**Caveat -- doesn't fully close the loop:** this test's own CPU-encode
measurement (1.06x) is meaningfully below the user's originally reported
1.4x on their own test, using the same default settings. Encoder choice
explains real ground (CPU beats VAAPI by ~13% here), but not the entire
gap to 1.4x -- the remainder is most likely a different replay/beatmap's
object complexity, or a difference in how the 1.4x figure was read (e.g.
an in-progress `Speed:` log line vs. a true start-to-finish average),
neither of which this test isolates. Not resolved as of this writing.

### Session 5: found the exact blocking code, patched it, patch didn't help -- and two encoder fixes actually shipped

**Read `mainLoopRecord()` (`app/app.go`) and `checkData()`/`MakeFrame()`**
**(`app/ffmpeg/video.go`) directly in danser-go's own source** (shallow
cloned locally) instead of continuing to infer the mechanism from
profiling alone:

- `mainLoopRecord()`'s `for !p.Update(updateDelta)` loop wraps *everything*
  for a frame -- CPU game-state update, `pushFrame()` (draw calls), and
  `ffmpeg.MakeFrame()` (readback kickoff) -- in one
  `goroutines.CallMain(func(){...})` closure, executed strictly in order.
  Nothing prepares frame N+1's draw calls while frame N is still draining.
- **The upstream author already tried to fix exactly this.** `checkData()`
  carries this comment verbatim: `// I tried to do that on another
  thread, but it needs another opengl context and creates other funky
  problems`. This isn't an oversight sitting there unfixed for lack of
  attention -- it's a known-hard problem the maintainer hit and backed
  away from. Worth knowing before spending real time trying to thread it
  ourselves.
- `MakeFrame()`'s only *blocking* wait is `gl.ClientWaitSync`, and only
  when `freePBOPool` (buffered channel, capacity `MaxVideoBuffers = 10`)
  is completely empty -- i.e. it's backpressure against downstream (pipe
  write + ffmpeg encode) falling behind, not a per-frame stall by
  design. At 144fps that's ~69ms of slack before it can engage.

**Tested the one cheap, low-risk lever this reading suggested:** patched
`MaxVideoBuffers` from 10 to 60 (`docker/Dockerfile`, a `sed` step after
`git clone` and before `go build` -- no fork needed) to see if backpressure
stalls were the dominant cost. Same 1440p144/VAAPI/xvfb-vgl settings as
the Session 2 baseline (537s, 0.254x, GPU busy mean 36.6%):

| | MaxVideoBuffers=10 (stock, Session 2) | MaxVideoBuffers=60 |
|---|---|---|
| Wall time | 537s | **608s** |
| Realtime multiplier | 0.254x | **0.225x** |
| GPU busy% mean | 36.6% | 34.2% |

**Result: worse, not better, and GPU utilization didn't move.** This is a
clean negative result -- if PBO-pool exhaustion were the dominant stall,
more headroom should never make things *worse*. It means the specific
mechanism in `checkData()`/`MakeFrame()` isn't where the time is actually
going, even though the broader "no frame-ahead pipelining" diagnosis
(Session 2/3, confirmed via real profiling) still stands as an accurate
description of the *symptom*. The real bottleneck is still unidentified
at the precise-line level -- most likely somewhere in the ffmpeg pipe
write/encode throughput itself, or GL driver-level submission overhead,
neither of which this experiment isolated. **Patch reverted** (`docker
/Dockerfile`'s `sed` line removed, left as a comment explaining what was
tried and why it didn't help, worker rebuilt back to stock).

**What actually shipped this session (real, verified, deployed):**
- The `def` profile (defaults: 1080p60) was silently set to `h264_vaapi`
  even though the schema's own default is `libx264` -- fixed to
  `libx264`, matching Session 4's measured ~13% win at that resolution.
- The `quality 1440p144hz` profile was tested with `libx264` (following
  the same logic) and measured *slower* than its existing VAAPI setting
  (590s/0.232x vs 537s/0.254x) -- **reverted back to VAAPI**. Net lesson:
  **CPU-vs-VAAPI is resolution-dependent, not a universal rule** -- CPU
  wins at 1080p60, VAAPI wins at 1440p144, and this project's two shipped
  profiles now each use whichever is actually faster at their own
  settings rather than one blanket choice.
- `WORKER_DISPLAY_MODE` reverted to `xvfb-vgl` at this point in the session
  (Session 3: Xorg/real-display mode showed no benefit and a mild
  regression *for VAAPI*) -- **this specific revert turned out to be
  wrong for the common case; see Session 6 immediately below, which
  reverses it back to `xorg`.**
- Passwordless sudo for `jellyfin` on `.115` (`/etc/sudoers.d/jellyfin-
  nopasswd`) remains in place from Session 3, used throughout this session
  for the GRUB edit, container rebuilds, and process management -- still
  worth revisiting as a broad grant if hardening worker security later.

### Session 6: display mode and encoder choice interact -- Session 3's finding only held for VAAPI

The user reported default-settings renders feeling slower after Session 5's
changes. Investigated by re-running the exact same replay+`def`-profile
test (`1080p60`, `libx264`, score URL `https://osu.ppy.sh/scores/7231969788`)
that Session 4 had already measured at 129s/1.06x -- and got **163s/0.838x**
instead, a genuine ~26% regression, not noise (identical replay, identical
profile, identical -- by then reverted-to-stock -- danser build).

The difference: **Session 4's 129s measurement was taken while the worker**
**was still in Xorg mode (carried over from Session 3), not `xvfb-vgl`.**
Session 5 reverted to `xvfb-vgl` afterwards based on Session 3's finding --
but Session 3 only ever tested Xorg vs. `xvfb-vgl` *with VAAPI encode*. It
was never tested against `libx264`. Isolated it directly: switched back to
Xorg, re-ran the identical `def`-profile test, got **132s/1.035x** --
matching Session 4's original number almost exactly.

| | libx264 (CPU) | VAAPI |
|---|---|---|
| Xorg mode | 129-132s (~1.05x) | 646s / 0.211x (Session 3) |
| `xvfb-vgl` mode | 163s / 0.838x | 537s / 0.254x (Session 2) |

**Neither display backend is universally better -- it depends on the**
**encoder.** Xorg is ~23% faster for CPU/`libx264` encode; `xvfb-vgl` is
~17% faster for VAAPI. Given `def` and `ultra super duper fast` (the two
most-likely-to-be-used profiles, including the raw schema defaults) both
use `libx264`, while only the deliberately-demanding `quality 1440p144hz`
profile uses VAAPI, **Xorg is very likely the better deployed default for
real traffic** even though Session 3's narrower VAAPI-only test pointed
the other way. **Currently deployed: `WORKER_DISPLAY_MODE=xorg`** (left
this way pending the user's confirmation, to avoid further live-config
churn this session already did twice). If kept, the `quality 1440p144hz`
profile takes a real ~17% hit relative to its Session 2 number -- worth
being aware of, not necessarily worth reversing.

### Session 7: final fastest-known config, given the user wants pure speed with no other tradeoff considered

Ran the one remaining untested combination -- `libx264` (CPU) at
`2560x1440@144` *under Xorg mode* -- to settle Session 6's open question
of whether Xorg's CPU-encode advantage held at the higher resolution too.
Full picture across every combination tested this investigation, same
replay throughout:

| | VAAPI | libx264 (CPU) |
|---|---|---|
| `xvfb-vgl` mode | 537s / 0.254x (Session 2, **fastest overall**) | 590s / 0.232x (Session 5) |
| Xorg mode | 646s / 0.211x (Session 3) | 586s / 0.233x (Session 7, essentially tied with the `xvfb-vgl` `libx264` number) |

**No single `WORKER_DISPLAY_MODE` is fastest for both profiles at once** --
`xorg` wins decisively for `def`'s 1080p60/`libx264` (~132s vs ~163s, a
real ~23% gap), while `xvfb-vgl`+VAAPI remains the single fastest number
ever measured at 1440p144 (537s), unreachable at the same time as the
1080p60 win since they need opposite display backends on a worker that can
only run one at a time.

**Given the user's explicit priority ("I just want it as fast as
possible") over any other tradeoff, the deployed state is:**
- `WORKER_DISPLAY_MODE=xorg` -- kept, since it wins by a wider margin
  (~23%) on the far-more-commonly-used 1080p60/CPU path than it loses
  (~17%) on the deliberately-extreme 1440p144 path.
- `def` profile: `libx264` -- fastest known combination for its settings
  (~132s).
- `quality 1440p144hz` profile: switched to `libx264` (was VAAPI) --
  within the now-deployed Xorg mode, `libx264` genuinely beats VAAPI here
  too (586s vs 646s, ~9% faster), even though neither touches the 537s
  ceiling that only exists under the display mode this profile isn't
  using. **This is the fastest achievable number for this profile given
  the single shared `WORKER_DISPLAY_MODE`** -- reaching 537s again would
  require either per-job display-mode switching (not implemented -- would
  need a container restart per job, likely not worth the overhead it'd
  add) or running two separate worker deployments split by encoder.
- `ultra super duper fast` (720p30, `libx264`): not independently
  retested this session, but follows the same pattern as `def` -- already
  on the encoder Xorg favors.

**If a genuine per-profile-optimal setup is ever wanted instead of one**
**global tradeoff**, the two real options are: (a) accept the current
single-worker compromise (what's deployed now), or (b) run two worker
deployments -- one in each display mode -- and route jobs to whichever
matches their `videoCodec`, which is a real infrastructure change, not a
config flip.

### Session 8: coordinator-CPU ruled out; the encode preset is the biggest lever found in this whole investigation

**Coordinator-CPU rendering, tested and ruled out.** The user asked
whether rendering through the coordinator's own CPU might beat the
worker. Checked the coordinator's actual hardware first: `.118` is a
**1 vCPU / 1.9GB RAM QEMU VM** -- provisioned as a lightweight job-queue/
web-UI box, never intended for rendering. Confirmed empirically anyway:
temporarily flipped `RENDER_MODE=local`, submitted the same `def`-profile
test, and killed it after clear signal (30% progress in ~161s wall time
= **~0.25x realtime, roughly 4x slower** than the worker's 1.05x on
identical settings) rather than let a single core running software
(llvmpipe) rendering *and* libx264 encoding *and* serving the live public
UI simultaneously run for a full ~9 minutes. Reverted `RENDER_MODE` back
to `worker` immediately after, confirmed the coordinator healthy
(`HTTP 200` on `/api/config`). **Conclusion: never render on the
coordinator -- the worker (GPU render, real multi-core CPU) is
unambiguously correct, no further testing needed here.**

**The `encodePreset` field turned out to be the single biggest speed**
**lever found across this entire multi-session investigation** -- bigger
than the CPU-vs-VAAPI encoder question (Session 4, ~13%), bigger than
display mode (Session 6, ~23%). Tested at the `def` profile's settings
(1080p60, `libx264`, Xorg mode), varying only `encodePreset`:

| Preset | Wall time | Realtime multiplier | Output file size (~132.5s content) |
|---|---|---|---|
| `faster` (previous default) | 132s | 1.04x | ~90MB (estimated from a live job's bitrate) |
| `veryfast` | 102s | 1.34x | 94MB |
| `superfast` | 70s | **1.95x** | 160MB |
| `ultrafast` | 41-42s (two runs, reproducible) | ~3.15x | 290MB |

**Why this works, and why it wasn't obvious from CPU%:** Session 5's
source-level finding was that danser's render loop is *latency*-bound
(blocks on `gl.ClientWaitSync` when downstream backpressure fills the PBO
pool), not throughput-bound -- every profiling run this session showed
neither GPU nor CPU anywhere near saturated. x264's `faster` preset (and
even `veryfast`, to a lesser extent) still does real per-frame work --
multi-frame lookahead, B-frame decision analysis -- that adds genuine
*latency* to each frame without necessarily showing up as high average
CPU%. `ultrafast` disables nearly all of that. In a latency-bound
pipeline, cutting per-frame latency pays off far more than the raw CPU%
numbers would suggest -- which is exactly the ~3x, not ~1.3x, jump
observed. This is consistent with (not a contradiction of) the Session 2/3/5
diagnosis; it's the first lever tested that actually targets the
*latency* side of the problem rather than throughput or hardware routing.

**The real tradeoff, and why `superfast` -- not `ultrafast` -- is what**
**actually shipped:** the four presets don't form a smooth curve.
`veryfast`->`superfast`->`ultrafast` each cut roughly 30-40% more wall
time, but `ultrafast` is qualitatively different from the other three: it's
the only x264 preset that disables B-frames and CABAC entirely, not just a
"smaller motion-search window" tier like the others. Since this project
uses CRF-based encoding (`crf: 16`, fixed across every test here), preset
mostly trades *file size/bitrate needed to hit the same quality target*
for speed -- visual quality is meant to stay roughly constant by design --
but `ultrafast`'s B-frame/CABAC removal is a real algorithmic
simplification that can cost visible quality beyond what extra bits buy
back, unlike `superfast` and above. After the user clarified they didn't
want "too much" quality dropoff for speed, **switched the shipped
`fastest 1080p60` profile from `ultrafast` to `superfast`**: 1.95x
realtime (essentially double the original 1.04x `faster` baseline) at
160MB, versus `ultrafast`'s 3.15x at 290MB with a real quality-mechanism
cost, not just a size one. `def` itself remains untouched as the
`faster`-preset balanced default.

### Session 9: two real code changes -- one a genuine bug fix, one a negative result worth keeping documented

Asked directly "what can you change in the *code*" (not just settings) to
go faster. Two things came from reading actual source rather than tuning
existing knobs:

**1. `Graphics.Experimental.UsePersistentBuffers` (danser-go) -- tested,**
**regressed, reverted.** Found via source reading
(`app/states/player.go`/`app/settings/graphics.go`): an upstream
"Experimental" flag controlling whether the sprite/vertex batch renderer
(`player.batch`, used every frame for hit circles/cursor/UI -- separate
from the video-encode PBO pool) uses persistent-mapped GPU buffers instead
of the default orphaning strategy. Off by default upstream. Patched
directly into the live `base.json` on the worker (`node -e`, no rebuild
needed since it's just a settings value) and tested at identical
`def`-profile settings otherwise (1080p60, `libx264`, `faster` preset,
Xorg mode): **159s vs the known 132s baseline -- a genuine ~20%**
**regression**, not the hoped-for additional win. Reverted immediately.
Plausible explanation: Mesa's RadeonSI persistent-buffer-mapping path is
less mature/optimized on this Polaris-generation card than on whatever
hardware upstream tests against. Recorded here specifically so a future
session doesn't re-try it without new evidence -- same spirit as Session
5's `MaxVideoBuffers` negative result.

**2. Worker concurrency -- real code added, real bug fixed along the**
**way, but no net throughput win for this workload (kept available,**
**deployed at 1 either way).** Every profiling run this entire
investigation showed the GPU 35-50% busy and CPU well under saturated
during a render -- real headroom a strictly-one-job-at-a-time worker never
used. Checked `server/src/worker.js`'s `pollLoop()`: it `await`s each
`processJob()` fully before polling for the next job, no concurrency at
all. Added `WORKER_CONCURRENCY` (env var, defaults to 1 -- today's
behavior unchanged unless raised): the loop now tracks an `active` counter
and fires `processJob()` without awaiting it, up to the configured limit,
polling for more work as soon as a slot frees up. Verified the coordinator
side (`lib/remoteWorker.js#claimNext()`) is already safe for this --
synchronous, atomically shifts off the ready queue, no race risk from a
worker polling for a second job while the first is still in flight.

Testing this surfaced a **real, independent bug**: raising
`RENDER_CONCURRENCY` in the coordinator's `.env` had *no effect* --
`docker-compose.yml`'s `environment:` block hardcoded
`RENDER_CONCURRENCY=1` directly, which Compose applies *after* (and
therefore overrides) `env_file: .env` for the same key. This made the
`.env` file's own documented `RENDER_CONCURRENCY` setting completely inert
-- nobody using this project could ever have raised it, regardless of
worker-side changes, without editing the compose file itself. **Fixed**
by removing the hardcoded line from `docker-compose.yml` (the app code's
own `Number(process.env.RENDER_CONCURRENCY || 1)` fallback in `render.js`
already covers the "unset" case safely, so nothing else needed to
change). This fix is worth keeping regardless of whether concurrency
itself turns out to help.

With both fixed and set to 2, two jobs genuinely ran concurrently on the
worker (two live `danser` PIDs confirmed, both completed successfully,
both got real Zipline share links). But the **throughput result was a
wash, not a win**, for this workload: two `1080p60`/`libx264`/`faster`
jobs submitted together finished in ~276s combined, essentially the same
as running them sequentially (2x132s = 264s) -- if anything marginally
worse. Two simultaneous `libx264` encodes contend hard enough for the
4-core worker's CPU that the parallelism gain and the contention cost
roughly cancel out. **Reverted `WORKER_CONCURRENCY`/`RENDER_CONCURRENCY`**
**back to 1 on both machines** as the safe, no-worse-than-before default --
the code capability stays in the repo for whenever it's worth revisiting
(e.g. against GPU/VAAPI-encode jobs specifically, which contend for CPU
much less than two simultaneous `libx264` encodes do, though VAAPI has its
own Session-4-documented stalling issues to weigh against that).

### Session 10: shipped superfast everywhere; MaxVideoBuffers retested against CPU encode (still no win); found the worker's disk was completely full

**Shipped the Session 8 finding as the actual live default**, not just a
separate opt-in profile: `encodePreset` schema default changed from
`faster` to `superfast` (`lib/settingsSchema.js`), and both `def` and
`quality 1440p144hz` saved profiles updated to match (`ultra super duper
fast` was already on `ultrafast`). Verified end-to-end after deploy, same
replay throughout: `def` (1080p60) **132s/1.04x -> 66s/2.07x**;
`quality 1440p144hz` (1440p144) **586s/0.23x -> 274s/0.50x**. Both
essentially doubled, live in production.

**Re-tested `MaxVideoBuffers=60` against CPU encode specifically** (same
Dockerfile `sed`-patch technique as Session 5, which only ever tested it
against VAAPI). Reasoning: if slow encode causing `MakeFrame()`'s
pool-exhaustion backpressure was part of what the encode-preset fix
resolved, a wider buffer might still add something on top. Result: **68s,
statistically identical to the 66s stock-buffer baseline.** No
improvement. Consistent explanation: `superfast` already relieved
whatever backpressure existed, so there's no more stalling left for a
bigger buffer to absorb. Reverted immediately, same as Session 5's
result -- **this constant is not a productive lever for this workload
under either encoder**, don't retry it again without new evidence.

**Found a real, separate, urgent problem while profiling this test, and**
**fixed it properly:** the worker's root filesystem (`.115`) was **100%**
**full** (29GB/30GB), which directly caused a `No space left on device`
error attempting to write a profiling log. Root cause: `/data/output/` had
accumulated **58 rendered video files, 13GB total, dating back to Aug 8**
-- `worker.js` uploads every finished render to the coordinator
(`POST /api/internal/jobs/:id/result`) but never deleted its own local
copy afterward, so every test render across this entire multi-session
investigation just piled up indefinitely on the worker specifically (the
coordinator's own copy is the durable one from there -- see
`routes/internal.js`'s `/result` handler and, from there, Zipline if
configured).

Verified before touching anything: pulled a sorted filename list from both
machines, `diff` showed **identical file sets**, spot-checked several file
sizes byte-for-byte identical -- confirmed the worker's copies were 100%
redundant, not the only copy of anything. Deleted them (13GB freed, disk
back to 63% used). **Then fixed the actual bug**, not just the symptom:
`worker.js#processJob()` now deletes `outputPath` and danser's
`{jobId}_temp` mux-scratch directory immediately after a successful
upload to the coordinator, on both the success path and the error/catch
path (a crashed render was exactly what left at least one stale `_temp`
dir from Aug 8 that a success-only cleanup would have missed). Verified
live: rendered a fresh job, confirmed the coordinator received it
(`outputPath: true`) *before* confirming the worker's local copy was gone
(`ls`: no such file, 0 remaining `.mp4`s) -- correct order, no data-loss
window. The coordinator's own `/data/output` still has no retention
policy (every render it's ever received still sits there) -- lower
urgency since it wasn't the one that filled up, but the exact same kind of
unbounded growth exists there too; noted under "Known loose ends" below.

**Xorg native rendering path** (infrastructure proven working across
several sessions -- Sessions 1/3 found no win from it with VAAPI, **Session
6 found a real ~23% win from it with `libx264`/CPU encode**):
`docker/worker-entrypoint.sh` supports
`WORKER_DISPLAY_MODE=xorg` (opt-in; **the deployed default was `xvfb-vgl`**
after Session 1's investigation, decided by the user once the Xorg
path was confirmed to be a non-win -- same speed either way, `xvfb-vgl` is
simpler/more proven; see Session 3 above for why this was revisited and
what changed). Starts a real Xorg server against the amdgpu DDX
driver (`docker/xorg-worker.conf`) instead of Xvfb, skips VirtualGL
entirely (`USE_VIRTUALGL` unset -> `lib/danser.js` runs danser directly).
Needs, all live-verified working on `.115`:
- A connector forced "connected" at the kernel level: `video=HDMI-A-1:D`
  boot param in the worker VM's GRUB config (software equivalent of a
  physical HDMI dummy plug, since the user didn't have physical access to
  the box -- works reliably for HDMI/DVI specifically because TMDS is
  purely source-driven with no handshake required, unlike DisplayPort
  which needs real electrical AUX-channel link training a software force
  can't fake).
- `xserver-xorg-core`/`xserver-xorg-video-amdgpu` in the Dockerfile, plus
  an `/etc/X11/Xwrapper.config` override (`allowed_users=anybody`) since
  Xorg.wrap otherwise refuses to start without a real console session.
- Xorg pinned to **VT 7** explicitly (`/dev/tty7` passed through in
  `docker-compose.worker.yml`) -- letting it auto-pick defaults to VT 1,
  the host's *real* login console, worth avoiding outright rather than
  fighting over it.
- Explicit `BusID "PCI:0:16:0"` in `xorg-worker.conf` -- this box has two
  PCI display devices (Proxmox's own emulated Bochs/QEMU VGA console *and*
  the real GPU), and an unconfigured Device section falls back toward the
  "primary" one (the Bochs device), producing "no screens found" without
  this.
- Confirmed live: `GL Renderer: AMD Radeon RX 570 Series (polaris10, ...)`
  in the worker's log, genuine native hardware GL, full job completed and
  uploaded successfully. **Then confirmed to be the same speed as
  `xvfb-vgl` (~0.9x), and reverted to `xvfb-vgl` as the deployed config**
  -- the Xorg code all stays in the repo, proven working, in case it's
  ever useful again (e.g. if VirtualGL turns out to matter more at
  different resolutions/settings than tested here).

**Realistic options from here:**
1. Accept ~0.85-0.94x (or ~0.25x at 1440p144-class settings) as the
   practical ceiling for this GPU/software combo.
2. Lower default render resolution/fps -- the only lever proven to help
   (~4x per resolution), zero engineering, real quality tradeoff.
3. ~~Get actual profiling on the box before touching any more code~~ --
   **done, see "Session 2" above.** Confirms neither GPU nor CPU is
   saturated; the loss is synchronization overhead between stages.
4. Real danser-go render-loop pipelining surgery -- biggest lift, but no
   longer a blind guess: Session 2's profiling data is real evidence this
   is the correct direction (nothing else is close to saturated). Still
   means forking upstream danser-go (see caveat above) and getting
   comfortable with its render loop / GL synchronization code before
   touching it -- not started as of this writing.

## RULED OUT (Session 11, same day as the plan below was written): zero-copy GPU encode -- eliminate the GPU->CPU->GPU round trip in VAAPI

**Verdict: don't build this.** Phase 0 below was actually run (not left
for a future session) and returned a clear, decisive no -- kept the full
original plan text underneath for the reasoning trail, but skip straight
to "Phase 0 -- validate" for the real numbers before reading the rest as
history rather than a live TODO.

The user wanted to push GPU usage further after Session 4 found VAAPI
losing to CPU encode. Below was originally written as a **handoff plan
for a future session** -- it assumed everything in Sessions 2-10 above.

**The diagnosis (confirmed from source, not guessed):** danser and ffmpeg
are two fully separate OS processes with no shared GPU context.
`app/ffmpeg/video.go#startVideo()` (Linux path) creates a real **named
pipe** (`files.NewNamedPipe()`) and passes its path to `exec.Command
(ffmpegExec, options...)` as `-i <pipe>`. Every frame's actual journey for
VAAPI is: danser renders on GPU -> danser's shader-based
`rgbToYuvConverter` converts to NV12 on GPU -> PBO readback copies
GPU->CPU (danser's own process) -> written through the named pipe -> read
by ffmpeg (a *different* process) -> `-vf hwupload` copies CPU->GPU again,
into ffmpeg's *own separate* VAAPI context -> hardware encode. That's a
full extra memory round-trip plus a cross-process context switch that the
CPU-encode path (which stops after the first GPU->CPU copy) never pays.
This is the most likely explanation for Session 4's finding that VAAPI's
GPU busy% was *lower* than CPU-encode's despite VAAPI doing strictly more
GPU work (render + encode vs. render only) -- time lost to the round trip
and its synchronization, not spent computing.

**Goal:** eliminate that second (CPU->GPU) leg entirely by keeping frame
data GPU-resident from render through hardware encode, so VAAPI stops
paying for a round trip CPU encode doesn't have. If the hypothesis above
is right, this could make VAAPI genuinely faster than the current
`superfast`/CPU baseline (66s / 2.07x at 1080p60) rather than a regression.
**This is not guaranteed** -- it's a real hypothesis with concrete
supporting evidence, not a certainty, same epistemic status the render-
loop pipelining theory had before Session 2's profiling confirmed it.

### Phase 0 -- validate before writing any code (cheap, do this first)

**Done. Result: stop here, don't proceed to Phase 1.** Ran a standalone
ffmpeg benchmark on the worker, completely decoupled from danser (a
60s/1920x1080@60 `testsrc2` source, generated once with `libx264
-preset ultrafast` as setup, not timed):

- **Test A -- zero-copy proxy** (`-hwaccel vaapi -hwaccel_output_format
  vaapi` hardware decode straight into `-c:v h264_vaapi` encode, frames
  never touch CPU memory -- the best real-world stand-in for what the
  full patch would achieve): steady-state **~85 fps = 1.42x realtime**.
- **Test B -- today's round-trip path** (normal CPU-side decode -> `-vf
  hwupload` -> `-c:v h264_vaapi`, structurally identical to what danser
  actually does): steady-state **~70 fps = 1.16x realtime**.

The round-trip hypothesis was *correct* -- it costs a real ~18% (1.42x ->
1.16x). **It doesn't matter.** Both numbers sit well below the
already-deployed CPU-encode baseline of **2.07x** (Session 10, `superfast`
preset) -- and that 2.07x figure includes *rendering and encoding
together*, while Test A/B are *encode alone*. This GPU's VCE 3.0 hardware
encode block has a real, fixed throughput ceiling (~1.42x-worth of
1080p60 pixels/sec, measured directly, not estimated from an old forum
post) that a perfect zero-copy implementation cannot raise -- it fixes the
*transport* cost, not the encode ASIC's own *throughput* limit, and the
throughput limit alone is already the binding constraint. No plausible
implementation of Phases 1-3 below can beat what's already running.
**Don't re-attempt this without new evidence that the underlying hardware
ceiling has changed** (e.g. different/newer worker GPU).

### Phase 1 -- feasibility research (go/no-go checkpoint)

Zero-copy needs the rendered/converted GPU texture exported as a handle
ffmpeg's VAAPI encoder can import directly, with no CPU touch. Two real
architectural approaches, evaluate both before committing to one:

- **Option A -- DMA-BUF export/import across the process boundary.**
  danser would need to export its post-`rgbToYuvConverter` texture via an
  EGL/GL extension (`EGL_EXT_image_dma_buf_export` or Mesa's
  `EGL_MESA_image_dma_buf_export`) as a DMA-BUF file descriptor, then get
  that FD into ffmpeg's separate process (Unix domain socket +
  `SCM_RIGHTS`, since FDs don't cross process boundaries any other way).
  ffmpeg's own CLI/rawvideo-from-pipe model doesn't naturally accept an
  externally-supplied DMA-BUF as input -- this likely means replacing the
  named-pipe/`-f rawvideo` approach with something else ffmpeg *can*
  consume as a DMA-BUF (e.g. a `v4l2` loopback-style device, or driving
  libavcodec/libva directly instead of shelling out to the `ffmpeg`
  binary at all -- see Option B). First confirm the DMA-BUF export
  extension is actually supported and functional on this box's exact
  stack (Mesa RadeonSI, Polaris/GCN4, whatever Mesa version the runtime
  image has) before assuming this path exists -- **this is the single
  biggest unknown in this whole plan and should be checked first**, e.g.
  with a small standalone EGL test program, before touching danser-go at
  all.
- **Option B -- danser drives VAAPI encode directly via cgo bindings to**
  **libva/libavcodec, dropping the separate `ffmpeg` subprocess for this**
  **path entirely.** Bigger rewrite of `app/ffmpeg`'s architecture (it
  currently *always* shells out to an external `ffmpeg` binary -- see
  `startVideo()`/`ffmpeg.go`), but avoids the inter-process boundary
  problem structurally rather than working around it, and stays within a
  single GL/VAAPI-interop context the whole time. More invasive to
  danser's design, but conceptually more likely to actually reach true
  zero-copy than bridging two independent processes via DMA-BUF passing.

Recommendation: spend Phase 1 on quick spikes for both (a throwaway EGL
DMA-BUF export test for A, a throwaway cgo+libva encode test for B)
before picking one to actually integrate -- don't commit to the bigger
Option A inter-process-FD-passing complexity, or Option B's rewrite, on
paper alone.

### Phase 2 -- implementation

Once a direction is chosen: prototype getting *one frame* through the
zero-copy path correctly (verify the output image is actually correct --
a subtly wrong DMA-BUF format/modifier can produce corrupted-looking but
technically-encoded video) before wiring it into the full
`mainLoopRecord()`/`MakeFrame()` loop. Land it as a fork (a real GitHub
fork with commit history is far more workable for a change this size than
the `sed`-in-Dockerfile technique used for Session 5/10's one-line
`MaxVideoBuffers` experiments) and point `docker/Dockerfile`'s
`DANSER_REF` build-arg at it. No fork currently exists as of this
writing -- setting one up (and getting push access sorted, since this
session never verified GitHub write access) is itself a Phase 2
prerequisite.

### Phase 3 -- measurement (reuse this investigation's existing methodology)

Same rigor as every other experiment in this file: real render via the
coordinator's Score URL path, same 136.638s replay used throughout,
`radeontop` GPU busy% capture, wall-clock timing via the danser-process-
lifetime method, compared directly against the current best-known
baselines (66s/2.07x at 1080p60 CPU/`superfast`; 274s/0.50x at 1440p144).
**Keep if it measurably beats CPU encode, revert without hesitation if it
doesn't** -- same standard applied to every other tested-and-reverted
lever this session (`MaxVideoBuffers`, `UsePersistentBuffers`, worker
concurrency).

### Honest risk assessment

This is the biggest, most uncertain undertaking in the whole investigation
-- genuine unfamiliar-codebase systems programming (EGL/DRM/DMA-BUF or
cgo/libva bindings), not a config change or small patch. Concrete risks:
Phase 1's feasibility check could fail outright (extension unsupported on
this Mesa/GPU combo); even if zero-copy works, this GPU's VCE 3.0 encode
block has known throughput ceilings (~1080p30/720p60-class, per the AMF
research done in this same session) that no amount of zero-copy plumbing
can raise -- **zero-copy fixes the transport overhead, not the encode
hardware's own throughput limit**, so there's a real chance this "succeeds"
technically and still doesn't beat `superfast` CPU encode at higher
settings. Nothing is lost by attempting it, though -- it doesn't touch the
currently-deployed CPU-encode config until proven better, same as every
other experiment this investigation has run.

A software-only "virtual display via `amdgpu.virtual_display=<PCI-ID>,1`
kernel parameter" route was investigated early on and rejected before any
of the above: it requires a VM kernel boot parameter (not
container-level), plus real DRM-master/TTY session permission issues that
forum reports describe as unreliable even when configured "correctly."
The `video=<connector>:D` approach actually used avoids all of that.

### Session 12: real profiling relocated the bottleneck, and a working (opt-in) CPU+GPU concurrent split-encode -- ~17% faster, shipped env-gated

This session finally instrumented `mainLoopRecord()` directly (not just
`radeontop`/`/proc` sampling from outside) and the numbers **relocated the
bottleneck away from where Sessions 2-5 had placed it.** A timing probe
patched into danser-go (per-frame breakdown, logged every 120 frames)
showed, at 1080p60/libx264/superfast:

- `pushFrame()` (the actual draw calls): **~0.1-0.45ms** -- essentially
  free. This matters a lot: it means the "no frame-ahead pipelining"
  render-loop rewrite that Sessions 2-5 kept circling back to as *the* fix
  **would buy almost nothing** -- there's no meaningful render work to
  overlap with readback in the first place.
- The GPU->host readback (`copy` of the persistently-mapped PBO): **~0.9ms**
  -- also cheap. (This directly refuted a mid-session PCIe-BAR-readback
  hypothesis; the readback is not the cost.)
- `MakeFrame()`'s wait for a free PBO (`<-freePBOPool`): **~5.2ms, ~65% of
  the entire per-frame budget**, with ~75-80% of frames stalling on it.
- A second probe split the downstream writer goroutine's work: the VRAM
  read was ~0.9ms but the **`videoPipe.Write()` into ffmpeg's named pipe
  was ~8ms** -- i.e. the PBO pool backs up because *ffmpeg can't drain the
  pipe faster than its own encode throughput*, and a live `ps` during a
  render showed **ffmpeg at ~294% CPU (≈3 of the worker's 4 cores),
  danser ~58%, total ~98% CPU** -- the box is CPU-encode-bound, not
  GPU/render-bound. So the real ceiling is x264's throughput on 4 cores,
  which sits *downstream* of everything danser's Go code does. The
  render-loop rewrite is off the table for good; keep the probe finding.

**What that unlocked: use the idle GPU as a second, concurrent encoder.**
Phase-0 validated (standalone ffmpeg, no danser) that a CPU x264 and a GPU
VAAPI encode running *simultaneously* each keep ~90% of their solo
throughput (CPU 2.34x->2.13x, GPU 0.88x->0.78x) -- they're genuinely
near-independent hardware. Combined ≈ 175fps vs CPU-alone's ~142fps.

**The patch** (`docker/patches/split-encode.patch`, ~800 lines against
danser-go, applied at Docker build via `git apply` -- same technique as the
Session 5/10 one-liners but far bigger; pinned to danser commit
`8331b0f`): danser renders each frame **once** (shared GL readback), then
routes contiguous ~5s **chunks** round-robin between two lanes -- primary
CPU `libx264` and a second GPU `h264_vaapi` -- each chunk a self-contained
ffmpeg process writing its own `chunk_NNNN.mp4`, all concatenated in index
order (stream copy, no re-encode) before the existing audio mux. New
danser settings: `Recording.SplitEncode` / `SplitEncoderName` /
`SplitEncoderCustomOptions` / `SplitEncoderFilters` / `SplitRatio`. Wired
into this project env-gated via `SPLIT_ENCODE_EXPERIMENT=1` in
`lib/danserSettings.js` (default path is byte-identical to stock danser).

**Two real bugs found and fixed along the way, both worth knowing:**
1. **Single-cutover doesn't overlap.** The first design gave the CPU the
   first 73% of frames and the GPU the last 27% in one block. Measured
   **92s / 1.44x -- a regression** (worse than CPU-alone), because the GPU
   sits idle until frame 5803 then runs alone: sequential, not concurrent.
   Overlap *requires* interleaving both lanes from the start -> hence
   round-robin chunks.
2. **The deep PBO pool is useless if the per-chunk write queue is shallow.**
   The chunked v1 made the PBO pool deep (600) but left each chunk's
   `writeQueue` at `MaxVideoBuffers=10`. `checkData` (GL thread) blocks
   when a chunk's writeQueue fills, so danser could still only get ~10
   frames ahead of any one encoder -> no real overlap, still **93s /
   1.42x**. Fix: size `writeQueue` to a whole chunk (`splitChunkFrames`),
   so danser can fill one lane's chunk and move to the next while the
   first drains in the background. That's what actually produced the
   overlap. (Const tunables in the patch: `splitChunkFrames=300`,
   `splitMaxInFlight=3` -> pool `= 300*3 = 900` PBOs ≈ 2.8GB VRAM at
   1080p NV12.)

**Results (RX 570 worker, same 136.6s replay/1080p60/superfast throughout,
same build, back-to-back):**

| Config | Wall time (danser start->finish) | Realtime | GPU busy% |
|---|---|---|---|
| CPU-only `superfast` (deployed default) | 74s | 1.79x | -- |
| Single-cutover split (v0) | 92s | 1.44x (regression) | -- |
| Chunked, shallow writeQueue (v1 bug) | 93s | 1.42x (regression) | -- |
| Chunked, `SplitRatio=0.73` | 69s | 1.92x | -- |
| **Chunked, `SplitRatio=0.60` (shipped)** | **61-62s** | **~2.15x** | **31% mean** |
| Chunked, `SplitRatio=0.50` | 63s | 2.08x | -- |

**`SplitRatio` (fraction of chunks kept on the CPU lane) is the key tune,
optimum ~0.6.** The naive throughput-ratio guess (0.73) left the GPU
under-fed (idle much of the run); pushing more onto it helped until ~0.5
started making the GPU the bottleneck. 0.6 = **~17% faster than CPU-alone
on the common 1080p path**, confirmed reproducible across two runs. Set as
the code default in `danserSettings.js` and via `SPLIT_ENCODE_RATIO` on
`.115`'s `.env`.

**Quality: verified transparent.** Because danser is deterministic, a
per-frame SSIM of the split output vs a pure-CPU render of the *same*
replay is a clean encoder-only diff: **mean SSIM 0.9982**, per-chunk band
0.9976 (GPU chunks) to 0.9989 (CPU chunks) -- a ~0.001 oscillation, far
below the ~0.99 perceptibility threshold; a side-by-side frame from a GPU
chunk vs the CPU reference is visually identical. No meaningful seams from
mixing libx264 + VAAPI segments. The **real** tradeoff is **file size**:
the split output is ~30% larger (209MB vs 160MB) because VAAPI `-qp 16`
runs a higher bitrate than libx264 `-crf 16` for equivalent quality.

**Honest limitations (why it shipped opt-in, not as the default):**
- GPU averaged only **31% busy** -- the win is real but well short of the
  ~3.2x theoretical ceiling (perfect overlap at combined throughput). The
  gap is GPU-lane inefficiency: per-chunk VAAPI process spawn (~200ms each)
  and the same VAAPI pipeline stalls documented in Session 4. Further
  tuning (`splitChunkFrames`/`splitMaxInFlight`) might squeeze more but
  each needs a rebuild; not chased down.
- **Only tested at 1080p60, one replay.** The tunables (pool depth, ratio)
  are calibrated for that. At 1440p frames are ~1.8x larger -> the 900-PBO
  pool would want ~5GB VRAM, tight on the 8GB card alongside rendering;
  `splitChunkFrames`/`splitMaxInFlight` would likely need to scale down.
  They're currently hardcoded consts in the patch.
- **Maintenance:** it's a large patch against danser `master`, re-applied
  at build; it will need re-checking whenever `DANSER_REF` moves.
- ~30% larger files (above), and ~2.8GB VRAM held during a render.

**Deployed state as of end of session:** `.115` worker running the
split-encode build with `SPLIT_ENCODE_EXPERIMENT=1`, `SPLIT_ENCODE_RATIO=0.6`
live. To turn it off for real traffic, set `SPLIT_ENCODE_EXPERIMENT=0` in
`.115`'s `.env` and `docker compose -f docker-compose.worker.yml up -d` --
the default (non-split) path is unchanged stock behavior. The patch/wiring
stays in the repo either way. **The timing-probe patch that produced the
diagnosis was removed** (job done); `docker/patches/timing-probe.patch` no
longer exists and the Dockerfile no longer applies it.

## Zipline integration -- debugging history (read before touching `lib/ziplineClient.js` again)

Multiple distinct, now-fixed bugs, in the order discovered:

1. **Missing MIME type on upload** -- `new Blob([bytes])` with no `type`
   uploaded as `application/octet-stream`; Zipline serves back whatever
   content-type it received. Fixed by setting the right MIME type from the
   file extension.
2. **IPv6-resolves-but-unreachable network** -- the user's network has
   IPv6 disabled entirely. Node's native `fetch()` handles a
   resolves-but-unroutable AAAA record much worse than curl's Happy-Eyeballs
   fallback (curl tries IPv6, gets "Network is unreachable", falls back to
   IPv4 automatically and near-instantly; Node's fetch can just fail).
   Fixed with `dns.setDefaultResultOrder("ipv4first")` at the top of both
   `index.js` and `worker.js`.
3. **Cloudflare's 100MB request body cap** -- srx.plose.dev is proxied
   through Cloudflare, which hard-rejects (413) request bodies over 100MB
   regardless of what Zipline itself would accept. Worked around by
   pointing `ZIPLINE_URL` at the LAN-direct app port instead
   (`http://192.168.10.117:3000`) to bypass Cloudflare's proxy entirely for
   uploads -- **note this means `ZIPLINE_URL` currently needs to be the LAN
   IP:port, not the public domain, for anything over 100MB**. Renders under
   that size work fine either way.
4. **fetch()'s automatic FormData encoding vs Zipline's multipart parser**
   -- both native `fetch()` and `node-fetch`'s automatic `FormData`
   handling produced `E1062: No files in multipart/form-data request`
   against the direct LAN endpoint specifically (worked fine over HTTPS
   through Cloudflare, which likely buffers/reframes the body). Root cause
   suspected: fetch-based `FormData` bodies get sent as `Transfer-Encoding:
   chunked` rather than a fixed `Content-Length`, and Zipline's parser
   didn't handle that as gracefully as curl (which always buffers `-F` data
   and sends an explicit `Content-Length`). **Fixed by building the
   multipart body manually** as a plain `Buffer` with an explicit
   `Content-Length` header, byte-for-byte matching curl's approach --
   see `buildMultipartBody()` in `lib/ziplineClient.js`. Verified against
   the real server with a real 13MB file (exact byte count + correct
   content-type preserved).
5. **Share link uses whatever host the upload hit** -- Zipline builds the
   URL in its upload response from the request's own host, not a fixed
   public domain. Since fix #3 requires `ZIPLINE_URL` to be the LAN IP
   (`http://192.168.10.117:3000`), the share link handed back was
   `https://192.168.10.117:3000/...` -- unreachable off the LAN and with no
   valid TLS cert there anyway, even though the upload itself succeeded.
   User confirmed `http://<ip>`, `https://<ip>`, `http://srx`, `https://srx`
   all work as *upload* targets, but the auto-generated link should always
   be the `srx` one regardless of which host `.env` points uploads at.
   **Fixed** by adding `ZIPLINE_PUBLIC_URL` (optional, falls back to
   `ZIPLINE_URL`) and rewriting the returned URL's scheme+host to it in
   `toPublicUrl()` in `lib/ziplineClient.js`, before the link is ever
   stored on the job or shown to the user. `.118`'s `.env` should have
   `ZIPLINE_PUBLIC_URL=https://srx.plose.dev` set alongside the LAN-IP
   `ZIPLINE_URL`.
6. **Zipline changed its chunked-upload protocol in a later v4 release** --
   files over `ZIPLINE_CHUNK_THRESHOLD_MB` (default 60) go through
   `/api/upload/partial` (`uploadChunkedToZipline()`), and right after the
   user updated their instance every such upload failed on chunk 1 with
   `E1002: Invalid partial upload`. Two server-side rule changes, read
   from Zipline trunk's `src/server/routes/api/upload/partial.ts` +
   `src/lib/api/partial.ts`: `content-range`'s end byte is now
   **inclusive** (was exclusive), and session continuity is a single-use
   `partialToken` returned by each chunk and sent back as
   `x-zipline-p-token` on the next (was a fixed `partialIdentifier` /
   `x-zipline-p-identifier`). Client updated to match. Confirmed the user's
   instance is **v4.8.2** (`GET /api/version`, needs the token) and that
   v4.8.2's source enforces exactly these rules; then verified **live**
   against it over the LAN (3.5MiB file, 1MiB chunks, 4 chunks, downloaded
   back byte-identical). Note the fix sat uncommitted for a week while
   `.118` kept running the old client and failing every >60MB upload with
   the same E1002 -- if this error ever reappears, check what `.118` is
   actually running before re-debugging the protocol. The final chunk's
   response marks the file `pending: true` -- Zipline assembles the chunks
   in a background worker, so the share link can 404 briefly right after
   upload. (The user moving Zipline's storage to a NAS at the same time was
   a coincidence, not the cause.)

**Last known state (unconfirmed as fully resolved):** after fix #4 was
deployed, one render still hit the Cloudflare 413 again -- meaning either
`ZIPLINE_URL` had drifted back to the public domain on `.118`, or that
specific render's output exceeded 100MB. Next step if this recurs: confirm
`.118`'s actual running `ZIPLINE_URL` value
(`docker compose exec renderer env | grep ZIPLINE`) and confirm which path
(LAN IP:3000 vs public domain) is actually configured, since both fixes
(#3 and #4) need to both be in effect simultaneously -- LAN IP *and* the
manual-multipart client.

## Known loose ends / non-blocking

- **The coordinator's `/data/output` has no retention policy** -- every
  render it's ever received (from local or worker rendering) stays there
  forever; only the worker side of this got fixed (see Session 10). Not
  urgent (coordinator disk wasn't the one that hit 100%), but the same
  unbounded-growth pattern exists there too. A simple age-based sweep or
  "delete N days after a successful Zipline upload" would close this.
- `skins-bundled/` directory exists but is unused dead weight from an
  earlier design (bundling third-party skins in the image) that was
  deliberately dropped for licensing reasons -- only danser's own built-in
  default skin ships; everything else is user-uploaded `.osk` via the web
  UI. Safe to delete `skins-bundled/`.
- No automated tests exist. Verification so far has all been manual/live
  (real replay renders, direct `node -e` script checks against real
  services). If adding tests, `lib/osrParser.js` and
  `lib/settingsSchema.js#validateAndMerge` are the most self-contained/easy
  wins.
- Docker Desktop on the Windows dev machine has crashed unprompted a couple
  times during long sessions -- if a `docker` command fails with a
  `dockerDesktopLinuxEngine` pipe error, it just needs relaunching
  (`Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`) and
  a short wait, not a real fix.
