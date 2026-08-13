# osu! replay &rarr; video (self-hosted)

A self-hosted, o!rdr-style renderer: upload an osu! replay (`.osr`) or paste
a score URL, tune the render (skin, cursor, objects, background, overlays,
output format) in a web UI, and get back an MP4. Rendering is done by
[danser-go](https://github.com/Wieku/danser-go); encoding by ffmpeg.

Everything runs in one Docker container using **CPU/software OpenGL
rendering** (Xvfb + Mesa llvmpipe) -- no GPU passthrough required, so it
works on any machine with Docker Desktop. It's slower than a real GPU, but
zero extra host setup.

## Quick start

1. `docker compose up --build`
2. Open http://localhost:8080
3. Drop in a `.osr` file, tweak options, hit Render.

Rendered videos and downloaded beatmaps/skins are cached in the
`render-data` Docker volume so re-renders of the same map are fast.

## Optional: render from a score URL

To paste an `osu.ppy.sh/scores/...` link instead of uploading a `.osr`:

1. Create an OAuth client at https://osu.ppy.sh/home/account/edit#oauth
   (any callback URL works -- this app only uses the machine-to-machine
   `client_credentials` grant, never your personal login).
2. Copy `.env.example` to `.env` and fill in `OSU_CLIENT_ID` /
   `OSU_CLIENT_SECRET`.
3. Restart with `docker compose up --build`.

Note: the osu! API only serves a replay for scores the player made
downloadable, and some scores require a user-authorized token rather than
an app-only one. If a score URL fails, export and upload the `.osr` instead
(from the score's right-click menu in-game).

## How rendering works

1. The server parses the `.osr` header to get the beatmap's MD5 hash.
2. It resolves that hash to a beatmapset via a public mirror
   (osu.direct / Nerinyan) and downloads the `.osz`, so you don't need a
   local osu! install or Songs folder.
3. Your chosen options are merged into a danser-go `settings.json`.
4. `danser` renders the replay against a virtual display and pipes frames
   to `ffmpeg` for encoding.

## Performance notes

Software rendering scales with resolution and CPU speed. As a rough guide:
720p/60fps with a fast x264 preset renders quickest; 4K or slow encoder
presets will take noticeably longer than the song itself. Use the
"encoder speed preset" option to trade render time for file size/quality.

If you have a spare machine with a real GPU on your network, see
"Optional: remote GPU render worker" below for a much faster path.

## Optional: auto-upload to Zipline

To have finished renders automatically uploaded to a self-hosted
[Zipline](https://github.com/diced/zipline) instance, with the resulting
share link shown next to the video on the frontend:

1. In your Zipline dashboard, go to Account/Settings -> API Tokens and
   generate a token (this is **not** your login password).
2. Set `ZIPLINE_URL` (e.g. `https://your-zipline-domain` or a LAN IP) and
   `ZIPLINE_TOKEN` in `.env`.
3. If `ZIPLINE_URL` is a LAN IP rather than your public domain, also set
   `ZIPLINE_PUBLIC_URL` to your real public Zipline URL -- otherwise the
   share link shown to users will be the unreachable LAN IP link Zipline
   hands back.
4. Restart with `docker compose up --build`.

If the upload fails for any reason (Zipline down, bad token, etc.) the
render still succeeds and stays downloadable locally -- sharing is
best-effort and never blocks the core flow.

## Optional: remote GPU render worker

By default everything -- web UI, job queue, and the actual danser render --
runs in one container using software OpenGL. If you have a second Linux
machine on your network with a GPU already passed through and working, you
can offload the actual rendering there: the worker polls this machine
("the coordinator") for jobs, renders using the real GPU, and ships the
finished video back. Beatmap resolution/downloading and everything else
still happens on the coordinator -- the worker only ever handles the
replay bytes, a beatmap archive, and your chosen settings.

This still encodes on CPU (libx264/libx265) -- only the actual frame
rendering (the slow part on software OpenGL) moves to the GPU. Hardware
video encode (AMD AMF/VAAPI) isn't wired up yet.

**On the coordinator** (this machine), in `.env`:
```
RENDER_MODE=worker
WORKER_TOKEN=<any long random string>
```

**On the GPU machine**, copy this whole project over (or just
`docker-compose.worker.yml`, `docker/`, `server/`, and `web/`), create a
`.env` there with:
```
WORKER_TOKEN=<same value as the coordinator>
COORDINATOR_URL=http://<coordinator's LAN IP>:8080
```
then run:
```
docker compose -f docker-compose.worker.yml up --build -d
```

The worker needs `/dev/dri` accessible (already wired into
`docker-compose.worker.yml`) -- if `docker compose up` fails to open the
device, add your user to the host's `video`/`render` groups. On startup
the worker logs which GL renderer Mesa picked; you're looking for your
GPU's name (e.g. `AMD Radeon ...`), not `llvmpipe` -- if you see
`llvmpipe` there, the container isn't actually seeing the passed-through
GPU and is silently falling back to software rendering.

Restart both sides after changing `RENDER_MODE`/`WORKER_TOKEN`.

## Optional: Discord bot

A separate, opt-in container that posts rendered videos into a Discord
channel. Two triggers:

- **Reply to a bathbot/owo score message** and `@mention` the bot in your
  reply -> renders the score shown in that message.
- **`@mention` the bot directly** (no reply, or replying to something that
  isn't a recognized score bot) -> renders your own most recent
  osu!standard score. Requires linking your account first with
  `/link <osu username>`.

The bot posts progress updates in-thread and edits them into the final
Zipline share link once the render finishes -- it never posts a raw video
attachment, so `ZIPLINE_URL`/`ZIPLINE_TOKEN` (see above) must be configured
for it to have anything to post.

Bathbot/owo message parsing is heuristic (their embeds don't carry a
stable per-score URL, only a beatmap link + player name) -- see
`bot/src/scoreParser.js` for exactly what it looks for, and the
`SCORE_BOT_IDS` env var if it misidentifies which bot messages to react to.

Setup:

1. Create a Discord application at
   https://discord.com/developers/applications, add a bot user, and enable
   **Message Content Intent** on the Bot tab.
2. Copy `.env.example` to `.env` and fill in `DISCORD_BOT_TOKEN` /
   `DISCORD_CLIENT_ID` (see the comment block in `.env.example` for exact
   steps, including the invite-link scopes/permissions needed).
3. Make sure `OSU_CLIENT_ID`/`OSU_CLIENT_SECRET` and
   `ZIPLINE_URL`/`ZIPLINE_TOKEN` are also set -- the bot needs both.
4. Start it explicitly (it's opt-in, not part of a plain `docker compose up`):
   ```
   docker compose --profile bot up --build -d
   ```

## Skins

The bundled default skin ships with danser-go itself. Upload your own
`.osk` skin file from the web UI to use it for a render -- uploaded skins
persist in the data volume for reuse.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET` | Enables score-URL rendering (optional) |
| `RENDER_CONCURRENCY` | Renders to run at once (default `1` -- keep low for CPU rendering) |
| `ZIPLINE_URL` / `ZIPLINE_TOKEN` | Enables auto-upload of finished renders to Zipline (optional) |
| `ZIPLINE_PUBLIC_URL` | Public domain for share links, if `ZIPLINE_URL` is a LAN IP (optional) |
| `RENDER_MODE` | `local` (default) or `worker` -- offload rendering to a remote GPU worker |
| `WORKER_TOKEN` | Shared secret between coordinator and worker (required for `RENDER_MODE=worker`) |
| `COORDINATOR_URL` | Worker-side only: `http://<coordinator LAN IP>:8080` |
| `DISCORD_BOT_TOKEN` / `DISCORD_CLIENT_ID` | Enables the Discord bot (optional, opt-in container -- see above) |
| `DISCORD_GUILD_ID` | Register the bot's slash commands to one guild instantly instead of globally (optional) |
| `SCORE_BOT_IDS` | Discord IDs of the score bot(s) whose messages the bot should read replies to (optional) |
| `BOT_RENDER_PROFILE` | Named render profile the Discord bot should use instead of defaults (optional) |
