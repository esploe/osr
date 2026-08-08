// Bridges a job that's ready to render to a remote worker VM that polls
// for work instead of the coordinator rendering it locally with danser.js.
// The coordinator still does everything up through resolving + downloading
// the beatmap (see renderPipeline.js) -- a worker only ever receives an
// already-resolved beatmap, replay bytes, and a settings object, so the
// beatmap-mirror logic never needs duplicating on the worker side.

const RESULT_TIMEOUT_MS = Number(process.env.WORKER_JOB_TIMEOUT_MS || 20 * 60 * 1000);

// jobId -> { job, replayPath, beatmapsetId, settings, dispatched, resolve, reject, timeout }
const entries = new Map();
const readyQueue = []; // jobIds waiting to be claimed

export function markReadyForWorker(job, { replayPath, beatmapsetId, settings }) {
  return new Promise((resolve, reject) => {
    entries.set(job.id, { job, replayPath, beatmapsetId, settings, dispatched: false, resolve, reject, timeout: null });
    readyQueue.push(job.id);
    job.setStage("waiting for a render worker", 25);
  });
}

export function claimNext() {
  while (readyQueue.length) {
    const jobId = readyQueue.shift();
    const entry = entries.get(jobId);
    if (!entry || entry.dispatched) continue; // stale entry, skip

    entry.dispatched = true;
    entry.job.setStage("rendering (remote worker)", 30);
    entry.job.log(`Dispatched to a remote worker.`);
    entry.timeout = setTimeout(() => {
      failJob(jobId, `No result from worker within ${Math.round(RESULT_TIMEOUT_MS / 60000)} minutes.`);
    }, RESULT_TIMEOUT_MS);

    return { jobId, replayFilename: `${jobId}.osr`, beatmapsetId: entry.beatmapsetId, settings: entry.settings };
  }
  return null;
}

export function getEntry(jobId) {
  return entries.get(jobId) || null;
}

export function relayLog(jobId, line) {
  const entry = entries.get(jobId);
  if (entry) entry.job.log(line);
}

export function relayStage(jobId, stage, progress) {
  const entry = entries.get(jobId);
  if (entry) entry.job.setStage(stage, progress);
}

// outputPath is already deterministic (dirs.output/<jobId>.<container>,
// computed by renderPipeline.js the same way for both local and remote
// rendering) -- the /result route just has to write the uploaded bytes
// there before calling this, so there's nothing to pass back here.
export function completeJob(jobId) {
  const entry = entries.get(jobId);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  entries.delete(jobId);
  entry.resolve();
  return true;
}

export function failJob(jobId, message) {
  const entry = entries.get(jobId);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  entries.delete(jobId);
  entry.reject(new Error(message));
  return true;
}
