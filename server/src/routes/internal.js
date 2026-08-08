import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { dirs } from "../lib/paths.js";
import { skinFolderName } from "../lib/danserSettings.js";
import * as remoteWorker from "../lib/remoteWorker.js";

export const internalRouter = Router();

const upload = multer({ dest: path.join(dirs.uploads, "tmp") });

// Every /api/internal/* route requires the shared worker secret -- this
// crosses machine boundaries on the LAN, so it's not left wide open even
// though there's no untrusted-user exposure expected.
internalRouter.use((req, res, next) => {
  const token = process.env.WORKER_TOKEN;
  if (!token) return res.status(503).send("Remote worker support is not configured (WORKER_TOKEN unset).");
  if (req.headers.authorization !== token) return res.status(401).send("Invalid worker token.");
  next();
});

internalRouter.get("/jobs/next", (req, res) => {
  const claimed = remoteWorker.claimNext();
  if (!claimed) return res.status(204).end();
  res.json(claimed);
});

internalRouter.get("/jobs/:id/replay", (req, res) => {
  const entry = remoteWorker.getEntry(req.params.id);
  if (!entry) return res.status(404).send("Unknown or already-completed job.");
  res.download(entry.replayPath);
});

internalRouter.get("/jobs/:id/beatmap.zip", (req, res) => {
  const entry = remoteWorker.getEntry(req.params.id);
  if (!entry) return res.status(404).send("Unknown or already-completed job.");
  const beatmapDir = path.join(dirs.songs, String(entry.beatmapsetId));
  if (!fs.existsSync(beatmapDir)) return res.status(404).send("Beatmap directory missing on coordinator.");

  res.set("Content-Type", "application/zip");
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => res.destroy(err));
  archive.pipe(res);
  archive.directory(beatmapDir, false);
  archive.finalize();
});

internalRouter.get("/jobs/:id/skin.zip", (req, res) => {
  const entry = remoteWorker.getEntry(req.params.id);
  if (!entry) return res.status(404).send("Unknown or already-completed job.");
  const name = skinFolderName(entry.settings.skinName);
  if (name === "default") return res.status(204).end(); // built-in skin, nothing to transfer

  const skinDir = path.join(dirs.skins, name);
  if (!fs.existsSync(skinDir)) return res.status(404).send(`Skin "${name}" missing on coordinator.`);

  res.set("Content-Type", "application/zip");
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => res.destroy(err));
  archive.pipe(res);
  archive.directory(skinDir, false);
  archive.finalize();
});

internalRouter.post("/jobs/:id/result", upload.single("file"), (req, res) => {
  const entry = remoteWorker.getEntry(req.params.id);
  if (!entry) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    return res.status(404).send("Unknown or already-completed job.");
  }
  if (!req.file) return res.status(400).send("No file uploaded (field name: file).");

  const outputPath = path.join(dirs.output, `${entry.job.id}.${entry.settings.container}`);
  fs.renameSync(req.file.path, outputPath);
  remoteWorker.completeJob(req.params.id);
  res.json({ ok: true });
});

internalRouter.post("/jobs/:id/error", (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message : "Worker reported an unspecified error.";
  const ok = remoteWorker.failJob(req.params.id, message);
  res.json({ ok });
});

internalRouter.post("/jobs/:id/log", (req, res) => {
  const { line, stage, progress } = req.body || {};
  if (typeof line === "string") remoteWorker.relayLog(req.params.id, line);
  if (typeof stage === "string") remoteWorker.relayStage(req.params.id, stage, progress);
  res.status(204).end();
});
