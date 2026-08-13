// Thin HTTP client for the coordinator's existing public API -- the bot
// never touches jobQueue/renderPipeline/danser directly, it's just another
// caller of POST /api/render, exactly like the web frontend's "Score URL"
// tab (see web/app.js#startRender). Zero coordinator-side changes needed.
const COORDINATOR_URL = process.env.COORDINATOR_URL || "http://renderer:8080";

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
