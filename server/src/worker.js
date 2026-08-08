import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
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

if (!COORDINATOR_URL || !WORKER_TOKEN) {
  console.error("worker.js requires COORDINATOR_URL and WORKER_TOKEN to be set.");
  process.exit(1);
}

const headers = { authorization: WORKER_TOKEN };

function api(pathname) {
  return `${COORDINATOR_URL}/api/internal${pathname}`;
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
  setStage(stage, progress) {
    console.log(`[${this.id}] stage=${stage} progress=${progress}`);
    this._relay({ stage, progress });
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

    await renderReplayToVideo({ job, replayPath, settings });

    const outputPath = path.join(dirs.output, `${jobId}.${settings.container}`);
    const bytes = fs.readFileSync(outputPath);
    const form = new FormData();
    form.append("file", new Blob([bytes]), path.basename(outputPath));

    const res = await fetch(api(`/jobs/${jobId}/result`), { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`Failed to upload result: HTTP ${res.status}`);
    job.log("Result uploaded to coordinator.");
  } catch (err) {
    job.log(`ERROR: ${err.message}`);
    await fetch(api(`/jobs/${jobId}/error`), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message: err.message }),
    }).catch(() => {});
  }
}

async function pollLoop() {
  for (;;) {
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
      await processJob(claimed);
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
