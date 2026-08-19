// Thin HTTP client for the coordinator's existing public API -- the bot
// never touches jobQueue/renderPipeline/danser directly, it's just another
// caller of POST /api/render, exactly like the web frontend's "Score URL"
// tab (see web/app.js#startRender). Zero coordinator-side changes needed.
//
// COORDINATOR_URL has no default here (same as server/src/worker.js's own
// COORDINATOR_URL) -- the bot is meant to run on its own machine/compose
// project (see docker-compose.bot.yml), so there's no Docker-internal
// service-name DNS to fall back to; index.js fails loudly at startup if
// this isn't set rather than silently pointing at a wrong/unreachable host.
const COORDINATOR_URL = (process.env.COORDINATOR_URL || "").replace(/\/+$/, "");

export async function submitRender(scoreUrl, settings) {
  const form = new FormData();
  form.set("scoreUrl", scoreUrl);
  if (settings) form.set("settings", JSON.stringify(settings));
  const res = await fetch(`${COORDINATOR_URL}/api/render`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Coordinator rejected the render (HTTP ${res.status}): ${await res.text()}`);
  }
  const { jobId } = await res.json();
  return jobId;
}

export async function getJob(jobId) {
  const res = await fetch(`${COORDINATOR_URL}/api/render/${jobId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch job status (HTTP ${res.status}).`);
  }
  return res.json();
}

export async function getProfileSettings(name) {
  if (!name) return null;
  const res = await fetch(`${COORDINATOR_URL}/api/profiles/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to load render profile "${name}" (HTTP ${res.status}).`);
  }
  return res.json();
}

// Same shape the web UI's skin dropdown consumes:
//   [{ id: "bundled:default", name: "danser default", bundled: true },
//    { id: "custom:MySkin",   name: "MySkin (uploaded)", bundled: false }, ...]
// The `id` is what goes into a render's settings.skinName -- the
// coordinator's danserSettings.js#skinFolderName() translates it back to
// the actual skin folder at render time.
export async function listSkins() {
  const res = await fetch(`${COORDINATOR_URL}/api/skins`);
  if (!res.ok) {
    throw new Error(`Failed to list skins (HTTP ${res.status}).`);
  }
  return res.json();
}
