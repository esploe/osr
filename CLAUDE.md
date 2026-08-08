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

No git remote is configured -- code moves via `tar` piped over `ssh` (from
the Windows dev machine, in Git Bash; `rsync` isn't installed there, and
`MSYS_NO_PATHCONV=1` is required or Git Bash mangles the remote paths):

```bash
cd "/path/to/osu-replay-renderer"
MSYS_NO_PATHCONV=1 tar --exclude='data' --exclude='.git' -czf - . | ssh <user>@<host> 'rm -rf /tmp/osu-replay-renderer-new && mkdir -p /tmp/osu-replay-renderer-new && tar -xzf - -C /tmp/osu-replay-renderer-new && echo COPY_OK'
```
Then on the remote host: copy over the existing `.env` (don't lose it),
swap the directory in, and rebuild:
```bash
cp /tmp/osu-replay-renderer/.env /tmp/osu-replay-renderer-new/.env
rm -rf /tmp/osu-replay-renderer && mv /tmp/osu-replay-renderer-new /tmp/osu-replay-renderer
cd /tmp/osu-replay-renderer
docker compose up --build -d                              # coordinator (.118)
sudo docker compose -f docker-compose.worker.yml up --build -d   # worker (.115), needs sudo
```

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

### Rendering speed investigation (unresolved, context for next time)

Bottom line so far: **CPU rendering (llvmpipe) and "GPU rendering + VAAPI
encode" both land around 0.8-0.92x realtime on the RX 570 worker** --
switching encoders/pixel-format didn't move the needle at all, which ruled
out the encoder as the bottleneck. Lowering resolution gave a genuine ~4x
speedup, proving it's throughput-bound (proportional to pixel count), not a
fixed per-frame latency cost.

Current best explanation: VirtualGL's mandatory per-frame frame-transport
copy (GPU → the fake Xvfb window danser renders into) is the dominant cost,
on top of danser's own separate pixel readback for the ffmpeg pipe. This is
architecturally why o!rdr's own worker boxes are so much faster on similar
hardware -- **o!rdr's client explicitly refuses to run without a real
physical display connected** (confirmed in their own source,
`MasterIO02/ordr-client`), meaning their danser renders natively with zero
bridging, no VirtualGL needed at all.

Two paths discussed, neither started:
1. **Physical HDMI/DP dummy plug** in the RX 570's actual output port
   (~$10). Since this is true VFIO PCI passthrough (not vGPU/SR-IOV), the
   guest's `amdgpu` driver should see a real EDID-detected display exactly
   like bare metal -- Proxmox's own VM console is a *separate* emulated
   display device (`bochs-drm`, confirmed via `lspci -k` showing two VGA
   controllers), so this wouldn't interfere with normal Proxmox access.
   User doesn't have physical access to the box for ~2 days as of last
   discussion.
2. **Patch danser-go for headless EGL/GBM rendering**, removing the GLFW/X11
   dependency (and therefore VirtualGL) entirely. Real Go source changes,
   not a config tweak -- scoped as "worth trying if the dummy plug doesn't
   pan out," not started.

A software-only "virtual display via `amdgpu.virtual_display=<PCI-ID>,1`
kernel parameter" route was investigated and rejected: it requires a VM
kernel boot parameter (not container-level), plus real DRM-master/TTY
session permission issues that forum reports describe as unreliable even
when configured "correctly." The dummy plug avoids all of that.

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
