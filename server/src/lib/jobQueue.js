import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";

export class Job extends EventEmitter {
  constructor(id, data) {
    super();
    this.setMaxListeners(50); // multiple SSE clients can watch the same job
    this.id = id;
    this.data = data;
    this.status = "queued"; // queued | running | done | error
    this.progress = 0; // 0-100, best-effort
    this.stage = "queued"; // human label for current pipeline stage
    this.eta = null; // danser's reported time-remaining string (e.g. "21s"), null when unknown
    this.speed = null; // danser's reported render speed multiplier (e.g. 1.91), null when unknown
    this.logs = [];
    this.error = null;
    this.outputPath = null;
    this.shareUrl = null;
    this.createdAt = Date.now();
  }
  log(line) {
    const entry = { t: Date.now(), line: String(line) };
    this.logs.push(entry);
    if (this.logs.length > 5000) this.logs.shift();
    this.emit("log", entry);
  }
  setStage(stage, progress, extra = {}) {
    this.stage = stage;
    if (progress !== undefined) this.progress = progress;
    if (extra.eta !== undefined) this.eta = extra.eta;
    if (extra.speed !== undefined) this.speed = extra.speed;
    this.emit("stage", { stage, progress: this.progress, eta: this.eta, speed: this.speed });
  }
  setProgress(p) {
    this.progress = p;
    this.emit("progress", p);
  }
  setStatus(status) {
    this.status = status;
    this.emit("status", status);
  }
  setShareUrl(url) {
    this.shareUrl = url;
    this.emit("share", url);
  }
  toJSON() {
    return {
      id: this.id,
      status: this.status,
      stage: this.stage,
      progress: this.progress,
      eta: this.eta,
      speed: this.speed,
      error: this.error,
      createdAt: this.createdAt,
      outputPath: this.outputPath ? true : false,
      shareUrl: this.shareUrl,
      meta: this.data.meta ?? null,
    };
  }
}

export class JobQueue {
  constructor({ concurrency = 1, run }) {
    this.jobs = new Map();
    this.pending = [];
    this.active = 0;
    this.concurrency = concurrency;
    this.run = run; // async (job) => Promise<void>
  }

  create(data) {
    const id = nanoid(10);
    const job = new Job(id, data);
    this.jobs.set(id, job);
    this.pending.push(job);
    this._pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  queuePosition(id) {
    const idx = this.pending.findIndex((j) => j.id === id);
    return idx === -1 ? null : idx;
  }

  _pump() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.active++;
      job.setStatus("running");
      Promise.resolve(this.run(job))
        .then(() => {
          job.setProgress(100);
          job.setStatus("done");
        })
        .catch((err) => {
          job.error = err.message || String(err);
          job.log(`ERROR: ${job.error}`);
          job.setStatus("error");
        })
        .finally(() => {
          this.active--;
          this._pump();
        });
    }
  }
}
