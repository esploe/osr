import fs from "node:fs";
import path from "node:path";
import { parseReplayHeader, modsToString } from "./osrParser.js";
import { resolveBeatmapByHash, ensureBeatmapsetDownloaded } from "./beatmapMirror.js";
import { parseScoreUrl, downloadReplayForScore } from "./osuApi.js";
import { validateAndMerge } from "./settingsSchema.js";
import { renderReplayToVideo } from "./danser.js";
import { markReadyForWorker } from "./remoteWorker.js";
import { isConfigured as ziplineConfigured, uploadToZipline } from "./ziplineClient.js";
import { dirs } from "./paths.js";

const RENDER_MODE = process.env.RENDER_MODE || "local"; // "local" | "worker"

/**
 * Runs the full pipeline for a queued job:
 *  1. obtain the .osr (either the uploaded file, or fetched from a score URL)
 *  2. parse its header to get the beatmap MD5 hash
 *  3. resolve + download the matching beatmapset from a mirror
 *  4. merge submitted options against the schema defaults
 *  5. invoke danser-go to render + encode the video
 */
export async function runRenderJob(job) {
  const { replayPath: uploadedReplayPath, scoreUrl, rawSettings } = job.data;

  job.setStage("resolving replay", 2);
  let replayPath = uploadedReplayPath;
  if (scoreUrl) {
    const { scoreId } = parseScoreUrl(scoreUrl);
    job.log(`Downloading replay for score ${scoreId} via osu! API...`);
    const buf = await downloadReplayForScore(scoreId);
    replayPath = path.join(dirs.uploads, `${job.id}.osr`);
    fs.writeFileSync(replayPath, buf);
  }

  const headerBuf = fs.readFileSync(replayPath);
  const meta = parseReplayHeader(headerBuf);
  job.data.meta = {
    playerName: meta.playerName,
    mode: meta.mode,
    modsString: meta.modsString,
    beatmapHash: meta.beatmapHash,
  };
  job.log(`Replay: ${meta.playerName} | ${meta.mode} | mods ${meta.modsString} | beatmap ${meta.beatmapHash}`);

  if (meta.modeByte !== 0) {
    throw new Error(`danser only supports osu!standard replays -- this one is ${meta.mode}.`);
  }

  job.setStage("resolving beatmap", 8);
  const beatmapInfo = await resolveBeatmapByHash(meta.beatmapHash);
  job.log(`Resolved beatmap: ${beatmapInfo.artist} - ${beatmapInfo.title} [${beatmapInfo.version}] via ${beatmapInfo.source}`);

  job.setStage("downloading beatmap", 15);
  await ensureBeatmapsetDownloaded(beatmapInfo.beatmapsetId, dirs.songs, {
    log: (l) => job.log(l),
  });

  const settings = validateAndMerge(JSON.parse(rawSettings || "{}"));
  const outputPath = path.join(dirs.output, `${job.id}.${settings.container}`);

  if (RENDER_MODE === "worker") {
    // Everything up to here (replay parsing, beatmap resolution/download)
    // already ran locally on the coordinator -- a worker only needs the
    // replay bytes, the resolved beatmapset id, and the settings object.
    await markReadyForWorker(job, { replayPath, beatmapsetId: beatmapInfo.beatmapsetId, settings });
  } else {
    job.setStage("rendering", 25);
    await renderReplayToVideo({ job, replayPath, settings });
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error("Render finished but no output file was produced.");
  }
  job.outputPath = outputPath;
  job.log(`Done -> ${outputPath}`);

  if (ziplineConfigured()) {
    job.setStage("uploading to Zipline", 99);
    try {
      const url = await uploadToZipline(outputPath, path.basename(outputPath));
      job.setShareUrl(url);
      job.log(`Uploaded to Zipline: ${url}`);
    } catch (err) {
      // Never fail the whole job over a sharing-service hiccup -- the
      // render itself already succeeded and is downloadable locally.
      job.log(`Zipline upload failed (render still succeeded): ${err.message}`);
    }
  }
}
