import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import unzipper from "unzipper";
import { EventEmitter } from "node:events";
import { dirs } from "./lib/paths.js";
import { renderReplayToVideo, ensureBaseSettings } from "./lib/danser.js";
import { skinFolderName } from "./lib/danserSettings.js";

// See index.js for why -- same fetch()-on-IPv6-only-routes gap applies to
// the worker's own calls back to the coordinator.
dns.setDefaultResultOrder("ipv4first");

const COORDINATOR_URL = (process.env.COORDINATOR_URL || "").replace(/\/+$/, "");
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 4000);
// Every profiling run in the rendering-speed investigation (see CLAUDE.md)
// showed the GPU 35-50% busy and danser/ffmpeg well under one core each
// during a render -- real headroom the strictly-one-job-at-a-time loop
// below never used. Defaults to 1 (today's behavior, unchanged) since this
// is genuinely untested against real concurrent load; raise deliberately.
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 1);

if (!COORDINATOR_URL || !WORKER_TOKEN) {
  console.error("worker.js requires COORDINATOR_URL and WORKER_TOKEN to be set.");
  process.exit(1);
}

const headers = { authorization: WORKER_TOKEN };

function api(pathname) {
  return `${COORDINATOR_URL}/api/internal${pathname}`;
}

// The X server (Xvfb or Xorg on :99) is started once by
// docker/worker-entrypoint.sh as a background process, after which
// `exec node` replaces the shell -- so for the rest of the container's
// life NOTHING supervises or restarts that display. If it dies (Xorg
// crash, GPU hang, VRAM/OOM pressure), danser's GLFW can no longer open
// the display and every render fails with "Failed to open display :99".
// Because this node process never exits on its own, docker-compose's
// `restart: unless-stopped` never fires, and the worker would otherwise
// sit wedged -- silently claiming and failing every job forever -- until
// a human restarts the container. Preflight-probe the display (same
// `xdpyinfo` check the entrypoint uses at startup) before each render; if
// it's gone, exit non-zero so Docker re-runs the entrypoint and rebuilds
// the display, turning an until-manual-restart outage into a self-heal.
//
// In native Xorg mode "alive" additionally means "has a monitor": if the
// real monitor on the GPU's output is unplugged / powered off mid-life,
// Xorg stays up but GLFW's GetPrimaryMonitor() returns nil and danser
// nil-panics in (*Monitor).GetVideoMode on every job. Same remedy -- exit,
// and the entrypoint's own no-monitor check falls back to xvfb-vgl on the
// way back up. (Regex mirrors xorg_has_monitor in worker-entrypoint.sh:
// connected AND lit, which is GLFW's own definition of a monitor.)
const DISPLAY_MODE = process.env.WORKER_EFFECTIVE_DISPLAY_MODE || process.env.WORKER_DISPLAY_MODE || "xvfb-vgl";

function displayIsAlive() {
  const display = process.env.DISPLAY || ":99";
  const res = spawnSync("xdpyinfo", ["-display", display], { stdio: "ignore" });
  if (res.status !== 0) return false;
  if (DISPLAY_MODE !== "xorg") return true;
  const xrandr = spawnSync("xrandr", ["--query"], { encoding: "utf8", env: { ...process.env, DISPLAY: display } });
  // xrandr missing/failing is not evidence the monitor is gone -- don't
  // restart-loop a working worker over a broken probe.
  if (xrandr.error || xrandr.status !== 0) return true;
  return / connected( primary)? \d+x\d+\+/.test(xrandr.stdout);
}

async function reportJobError(jobId, message) {
  await fetch(api(`/jobs/${jobId}/error`), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  }).catch(() => {});
}

// A minimal stand-in for lib/jobQueue.js's Job -- danser.js only ever
// calls .log()/.setStage()/.id on the object it's given, so this just
// relays those calls back to the coordinator instead of emitting locally.
class RemoteJob extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
  }
  log(line) {
    console.log(`[${this.id}] ${line}`);
    this._relay({ line });
  }
  setStage(stage, progress, extra = {}) {
    console.log(`[${this.id}] stage=${stage} progress=${progress} eta=${extra.eta ?? "-"}`);
    this._relay({ stage, progress, eta: extra.eta, speed: extra.speed });
  }
  _relay(body) {
    fetch(api(`/jobs/${this.id}/log`), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((err) => console.error(`log relay failed: ${err.message}`));
  }
}

// Buffered rather than streamed: replays are tiny and beatmapsets are at
// most tens of MB, so the memory cost is negligible, and it sidesteps a
// "Premature close" failure mode where node's fetch()-returned WHATWG
// stream races stream.pipeline()'s listener setup on fast/small responses.
async function downloadTo(url, destPath) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

async function downloadAndExtractZip(url, destDir) {
  if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) return "cached";
  const res = await fetch(url, { headers });
  if (res.status === 204) return "none"; // e.g. skin.zip for danser's own built-in default -- nothing to fetch
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  fs.mkdirSync(destDir, { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const directory = await unzipper.Open.buffer(buf);
  await directory.extract({ path: destDir });
  return "downloaded";
}

async function processJob(claimed) {
  const { jobId, beatmapsetId, settings } = claimed;
  const job = new RemoteJob(jobId);
  job.log(`Claimed job from coordinator.`);

  try {
    const replayPath = path.join(dirs.uploads, `${jobId}.osr`);
    await downloadTo(api(`/jobs/${jobId}/replay`), replayPath);

    const beatmapDir = path.join(dirs.songs, String(beatmapsetId));
    await downloadAndExtractZip(api(`/jobs/${jobId}/beatmap.zip`), beatmapDir);

    const skinName = skinFolderName(settings.skinName);
    if (skinName !== "default") {
      const skinDir = path.join(dirs.skins, skinName);
      const result = await downloadAndExtractZip(api(`/jobs/${jobId}/skin.zip`), skinDir);
      if (result === "none") job.log(`Skin "${skinName}" not found on coordinator -- danser will fall back to its default.`);
    }

    // The display server is unsupervised once the container is up (see
    // displayIsAlive above). Catch a dead display *before* burning the
    // render rather than after danser crashes on it: report the job failed,
    // then exit so Docker rebuilds the display instead of us failing the
    // next job the same way.
    if (!displayIsAlive()) {
      const display = process.env.DISPLAY || ":99";
      job.log(`FATAL: X display ${display} is unreachable -- the display server died. Failing this job and restarting the worker so Docker rebuilds the display.`);
      await reportJobError(jobId, `Worker display server (${display}) died; worker restarting.`);
      process.exit(1);
    }

    await renderReplayToVideo({ job, replayPath, settings });

    const outputPath = path.join(dirs.output, `${jobId}.${settings.container}`);
    const bytes = fs.readFileSync(outputPath);
    const form = new FormData();
    form.append("file", new Blob([bytes]), path.basename(outputPath));

    const res = await fetch(api(`/jobs/${jobId}/result`), { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`Failed to upload result: HTTP ${res.status}`);
    job.log("Result uploaded to coordinator.");

    // The coordinator (and from there, Zipline if configured) is the
    // durable copy from here on -- nothing on this machine ever serves a
    // download or a share link. Leaving rendered output sitting here
    // indefinitely was exactly what filled this box's disk to 100% once
    // (see CLAUDE.md's rendering-speed investigation, Session 10).
    fs.rm(outputPath, { force: true }, () => {});
    // danser's own mux scratch dir (video-only + audio-only intermediates
    // before it combines them into outputPath) -- not always cleaned up by
    // danser itself on error paths, so sweep it explicitly too.
    fs.rm(path.join(dirs.output, `${jobId}_temp`), { recursive: true, force: true }, () => {});
  } catch (err) {
    job.log(`ERROR: ${err.message}`);
    await reportJobError(jobId, err.message);
    // A failed/crashed render is exactly what tends to leave a partial
    // output file or danser's mux scratch dir behind -- sweep both so
    // errors don't quietly leak disk space over time either.
    fs.rm(path.join(dirs.output, `${jobId}.${settings.container}`), { force: true }, () => {});
    fs.rm(path.join(dirs.output, `${jobId}_temp`), { recursive: true, force: true }, () => {});
    // The display can also die *during* a render (passing the preflight
    // above, then crashing danser mid-frame). If it's gone now, this and
    // every future job are doomed until the display is rebuilt -- exit so
    // Docker's `restart: unless-stopped` re-runs the entrypoint and heals
    // the worker instead of leaving it wedged.
    if (!displayIsAlive()) {
      const display = process.env.DISPLAY || ":99";
      console.error(`X display ${display} died mid-render; exiting so Docker restarts the worker.`);
      process.exit(1);
    }
  }
}

async function pollLoop() {
  let active = 0;
  for (;;) {
    if (active >= WORKER_CONCURRENCY) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    try {
      const res = await fetch(api("/jobs/next"), { headers });
      if (res.status === 204) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (!res.ok) {
        console.error(`Poll failed: HTTP ${res.status}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const claimed = await res.json();
      active++;
      // Deliberately not awaited -- claiming and starting the next job
      // shouldn't wait for this one to finish, up to WORKER_CONCURRENCY.
      processJob(claimed).finally(() => {
        active--;
      });
    } catch (err) {
      console.error(`Poll loop error: ${err.message}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`osu-replay-renderer worker starting, polling ${COORDINATOR_URL}`);
ensureBaseSettings()
  .then(() => pollLoop())
  .catch((err) => {
    console.error("Failed to bootstrap danser settings:", err.message);
    process.exit(1);
  });
