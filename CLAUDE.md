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
| Render worker (GPU) | `192.168.10.115` | SSH user `jellyfin`. Runs `docker-compose.worker.yml`. Proxmox VM with an AMD RX 570 (Polaris) passed through via VFIO. `jellyfin` user needed `sudo` for docker commands (not in the `docker` group) as of last check. |
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

**Xorg native rendering path** (built and proven working as infrastructure,
even though it didn't fix speed): `docker/worker-entrypoint.sh` supports
`WORKER_DISPLAY_MODE=xorg` (opt-in; **the deployed default is back to
`xvfb-vgl`** after this investigation, decided by the user once the Xorg
path was confirmed to be a non-win -- same speed either way, `xvfb-vgl` is
simpler/more proven). Starts a real Xorg server against the amdgpu DDX
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

A software-only "virtual display via `amdgpu.virtual_display=<PCI-ID>,1`
kernel parameter" route was investigated early on and rejected before any
of the above: it requires a VM kernel boot parameter (not
container-level), plus real DRM-master/TTY session permission issues that
forum reports describe as unreliable even when configured "correctly."
The `video=<connector>:D` approach actually used avoids all of that.

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
