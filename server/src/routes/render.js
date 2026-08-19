import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { dirs } from "../lib/paths.js";
import { JobQueue } from "../lib/jobQueue.js";
import { runRenderJob } from "../lib/renderPipeline.js";

export const renderRouter = Router();

const upload = multer({
  dest: dirs.uploads,
  limits: { fileSize: 50 * 1024 * 1024 }, // .osr files are tiny; 50MB is generous headroom
});

const queue = new JobQueue({
  concurrency: Number(process.env.RENDER_CONCURRENCY || 1),
  run: runRenderJob,
});

renderRouter.post("/", upload.single("replay"), (req, res) => {
  const { scoreUrl, settings } = req.body;
  if (!req.file && !scoreUrl) {
    return res.status(400).send("Provide either a replay file (field: replay) or a scoreUrl.");
  }

  let replayPath;
  if (req.file) {
    replayPath = path.join(dirs.uploads, `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(req.file.path, replayPath);
  }

  const job = queue.create({ replayPath, scoreUrl, rawSettings: settings });
  job.log(`Job ${job.id} queued.`);
  res.json({ jobId: job.id });
});

renderRouter.get("/", (req, res) => {
  res.json(queue.list().map((j) => j.toJSON()));
});

renderRouter.get("/:id", (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).send("Unknown job");
  res.json(job.toJSON());
});

renderRouter.get("/:id/events", (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).send("Unknown job");

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // replay history so a client connecting mid-job isn't lost
  for (const entry of job.logs) send("log", entry);
  send("stage", { stage: job.stage, progress: job.progress, eta: job.eta, speed: job.speed });
  if (job.shareUrl) send("share", job.shareUrl);
  send("status", job.status);

  // Nothing more will ever come from a job that has already finished --
  // close the stream immediately so a client tailing a finished job
  // doesn't hang onto an idle connection forever.
  if (job.status === "done" || job.status === "error") {
    return res.end();
  }

  const onLog = (entry) => send("log", entry);
  const onStage = (s) => send("stage", s);
  const onShare = (url) => send("share", url);
  const onStatus = (s) => {
    send("status", s);
    if (s === "done" || s === "error") {
      cleanup();
      res.end();
    }
  };
  job.on("log", onLog);
  job.on("stage", onStage);
  job.on("share", onShare);
  job.on("status", onStatus);

  const cleanup = () => {
    job.off("log", onLog);
    job.off("stage", onStage);
    job.off("share", onShare);
    job.off("status", onStatus);
  };
  req.on("close", cleanup);
});

renderRouter.get("/:id/download", (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).send("Unknown job");
  if (job.status !== "done" || !job.outputPath) return res.status(409).send("Job not finished yet");
  res.download(job.outputPath);
});
