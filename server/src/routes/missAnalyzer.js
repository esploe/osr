import { Router } from "express";
import express from "express";
import path from "node:path";
import { parseReplayFull } from "../lib/osrParser.js";
import { parseBeatmap } from "../lib/beatmapParser.js";
import { analyzeMisses } from "../lib/missAnalyzer.js";
import { findBeatmapFileByHash } from "../lib/beatmapFinder.js";
import { resolveBeatmapByHash, ensureBeatmapsetDownloaded } from "../lib/beatmapMirror.js";
import { parseScoreUrl, downloadReplayForScore } from "../lib/osuApi.js";
import { dirs } from "../lib/paths.js";
import { Beatmap, Performance } from "rosu-pp-js";

export const missAnalyzerRouter = Router();

// pp for the actual play and for a hypothetical no-miss version (every
// miss recovered as a 300, full combo), computed with rosu-pp (the same
// algorithm osu! uses) off the cached .osu file. Best-effort -- a
// calculation failure returns null rather than breaking the analysis.
function computePp(content, replay) {
  try {
    const map = new Beatmap(content);
    const c = replay.counts;
    const mods = replay.mods; // osr bitfield, understood by rosu directly
    const current = new Performance({
      mods, n300: c.count300, n100: c.count100, n50: c.count50,
      misses: c.countMiss, combo: replay.maxCombo,
    }).calculate(map);
    const fc = new Performance({
      mods, n300: c.count300 + c.countMiss, n100: c.count100, n50: c.count50, misses: 0,
    }).calculate(map);
    return {
      current: Math.round(current.pp * 10) / 10,
      fc: Math.round(fc.pp * 10) / 10,
      stars: Math.round(current.difficulty.stars * 100) / 100,
    };
  } catch (err) {
    console.error("pp calc failed:", err.message);
    return null;
  }
}

// Core: given raw .osr bytes, parse + resolve + analyze and either send
// the full result JSON or an error JSON/text. Returns nothing (writes to
// `res` directly) so both the file-upload and score-URL entry points can
// share it.
async function analyzeReplayBytes(bytes, res) {
  const replay = await parseReplayFull(bytes);
  if (replay.modeByte !== 0) {
    return res.status(400).json({
      error: `Miss analyzer only supports osu!standard (mode 0); this replay is ${replay.mode}.`,
      header: publicHeader(replay),
    });
  }

  const resolved = await resolveBeatmapByHash(replay.beatmapHash);
  const beatmapsetDir = path.join(dirs.songs, String(resolved.beatmapsetId));

  let match = findBeatmapFileByHash(beatmapsetDir, replay.beatmapHash);
  if (!match) {
    // Not cached yet -- pull it, same code path the render pipeline uses.
    await ensureBeatmapsetDownloaded(resolved.beatmapsetId, dirs.songs);
    match = findBeatmapFileByHash(beatmapsetDir, replay.beatmapHash);
  }
  if (!match) {
    return res.status(404).json({
      error: `Beatmap file with MD5 ${replay.beatmapHash} not found inside beatmapset ${resolved.beatmapsetId} after download.`,
      header: publicHeader(replay),
    });
  }

  const beatmap = parseBeatmap(match.content);
  const { misses, stats, warning } = analyzeMisses({
    frames: replay.frames,
    beatmap,
    mods: replay.mods,
  });

  res.json({
    header: publicHeader(replay),
    beatmap: {
      artist: beatmap.artist,
      title: beatmap.title,
      version: beatmap.version,
      difficulty: beatmap.difficulty,
      objectCount: beatmap.hitObjects.length,
    },
    resolvedSource: resolved.source,
    beatmapsetId: resolved.beatmapsetId,
    misses,
    stats,
    warning,
    pp: computePp(match.content, replay),
  });
}

// Upload path: caller sends raw .osr bytes. Beatmap is downloaded
// on-demand into the same cache the render pipeline uses, so a replay
// that's already been rendered analyzes instantly.
missAnalyzerRouter.post("/analyze", express.raw({ type: "*/*", limit: "50mb" }), async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).send("Empty request body -- expected raw .osr bytes.");
    await analyzeReplayBytes(req.body, res);
  } catch (err) {
    console.error("miss-analyzer error:", err);
    res.status(500).send(`Miss analysis failed: ${err.message}`);
  }
});

// Score-URL path: fetch the .osr from the osu! API (same download the
// render pipeline uses), then analyze it. Requires OSU_CLIENT_ID/SECRET
// and the score itself must have a downloadable replay.
missAnalyzerRouter.post("/analyze-url", express.json(), async (req, res) => {
  try {
    const scoreUrl = req.body?.scoreUrl;
    if (typeof scoreUrl !== "string" || !scoreUrl.trim()) {
      return res.status(400).send("Provide a scoreUrl.");
    }
    const { scoreId } = parseScoreUrl(scoreUrl.trim());
    const bytes = await downloadReplayForScore(scoreId);
    await analyzeReplayBytes(bytes, res);
  } catch (err) {
    console.error("miss-analyzer url error:", err);
    res.status(500).send(`Miss analysis failed: ${err.message}`);
  }
});

// Header projection safe to hand back to the UI -- excludes the raw
// (large) frame array and internal offsets.
function publicHeader(replay) {
  return {
    playerName: replay.playerName,
    mode: replay.mode,
    modsString: replay.modsString,
    mods: replay.mods,
    counts: replay.counts,
    totalScore: replay.totalScore,
    maxCombo: replay.maxCombo,
    perfectCombo: replay.perfectCombo,
    beatmapHash: replay.beatmapHash,
    frameCount: replay.frames.length,
  };
}
