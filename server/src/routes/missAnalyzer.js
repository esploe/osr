import { Router } from "express";
import express from "express";
import path from "node:path";
import { parseReplayFull } from "../lib/osrParser.js";
import { parseBeatmap } from "../lib/beatmapParser.js";
import { analyzeMisses } from "../lib/missAnalyzer.js";
import { findBeatmapFileByHash } from "../lib/beatmapFinder.js";
import { resolveBeatmapByHash, ensureBeatmapsetDownloaded } from "../lib/beatmapMirror.js";
import { dirs } from "../lib/paths.js";

export const missAnalyzerRouter = Router();

// One shot: caller sends an .osr, we return everything the UI needs to
// render the miss list overlay (header meta, misses, beatmap difficulty
// info). Beatmap gets downloaded on-demand if it isn't already cached
// under dirs.songs -- same cache the render pipeline uses, so a replay
// that's already been rendered analyzes instantly.
missAnalyzerRouter.post("/analyze", express.raw({ type: "*/*", limit: "50mb" }), async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).send("Empty request body -- expected raw .osr bytes.");

    const replay = await parseReplayFull(req.body);
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
    });
  } catch (err) {
    console.error("miss-analyzer error:", err);
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
