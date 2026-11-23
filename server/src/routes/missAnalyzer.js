import { Router } from "express";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { parseReplayFull } from "../lib/osrParser.js";
import { parseBeatmap } from "../lib/beatmapParser.js";
import { analyzeMisses } from "../lib/missAnalyzer.js";
import { findBeatmapFileByHash } from "../lib/beatmapFinder.js";
import { resolveBeatmapByHash, ensureBeatmapsetDownloaded } from "../lib/beatmapMirror.js";
import { parseScoreUrl, downloadReplayForScore, getScore } from "../lib/osuApi.js";
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

// pp for a score from its API hit-counts (no replay needed). The play's
// current pp uses the *official* value the API returns (the exact lazer pp
// the user received); the no-miss pp is computed with rosu in lazer mode
// (every miss recovered as a 300, full combo) so it's consistent with how
// lazer scores. stars is the map's lazer star rating with these mods.
function computeSimPp(content, { mods, counts, maxCombo, officialPp }) {
  try {
    const map = new Beatmap(content);
    const cur = new Performance({
      mods, lazer: true, n300: counts.count300, n100: counts.count100,
      n50: counts.count50, misses: counts.countMiss, combo: maxCombo,
    }).calculate(map);
    const fc = new Performance({
      mods, lazer: true, n300: counts.count300 + counts.countMiss,
      n100: counts.count100, n50: counts.count50, misses: 0,
    }).calculate(map);
    const round2 = (x) => Math.round(x * 100) / 100;
    return {
      current: round2(officialPp != null ? officialPp : cur.pp),
      fc: round2(fc.pp),
      stars: round2(cur.difficulty.stars),
    };
  } catch (err) {
    console.error("sim pp calc failed:", err.message);
    return null;
  }
}

// Resolve + (if needed) download the .osu file for a beatmap md5, returning
// its raw content. Shared by the replay and score-URL simulation paths.
async function loadBeatmapContentByHash(beatmapHash) {
  const resolved = await resolveBeatmapByHash(beatmapHash);
  const beatmapsetDir = path.join(dirs.songs, String(resolved.beatmapsetId));
  // findBeatmapFileByHash walks the dir with readdirSync, which throws if it
  // doesn't exist yet -- so guard on existence and download first when the
  // set isn't cached, rather than letting an uncached set surface as ENOENT.
  const find = () =>
    fs.existsSync(beatmapsetDir) ? findBeatmapFileByHash(beatmapsetDir, beatmapHash) : null;
  let match = find();
  if (!match) {
    // Passing the hash makes a stale cached set (one predating an update of
    // this difficulty) get refreshed instead of skipped as "already cached".
    await ensureBeatmapsetDownloaded(resolved.beatmapsetId, dirs.songs, {
      beatmapHash,
      beatmapId: resolved.beatmapId,
    });
    match = find();
  }
  if (!match) {
    throw new Error(
      `Beatmap file with MD5 ${beatmapHash} not found inside beatmapset ${resolved.beatmapsetId} after download.`
    );
  }
  return { content: match.content, beatmapsetId: resolved.beatmapsetId, source: resolved.source };
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

  // Same existence guard as loadBeatmapContentByHash: findBeatmapFileByHash
  // throws ENOENT on a set that isn't cached yet.
  const find = () =>
    fs.existsSync(beatmapsetDir) ? findBeatmapFileByHash(beatmapsetDir, replay.beatmapHash) : null;
  let match = find();
  if (!match) {
    // Not cached yet, or cached but stale -- pull it, same code path the
    // render pipeline uses.
    await ensureBeatmapsetDownloaded(resolved.beatmapsetId, dirs.songs, {
      beatmapHash: replay.beatmapHash,
      beatmapId: resolved.beatmapId,
    });
    match = find();
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

// Score-URL simulation path: the "what if you hadn't missed" numbers WITHOUT
// needing a downloadable replay -- fetches the score's metadata from the
// osu! API (hit counts, mods, combo, beatmap) and computes pp off the cached
// .osu file. Works for any score the API exposes, unlike /analyze-url which
// needs the .osr frames for playfield miss detection.
missAnalyzerRouter.post("/simulate-url", express.json(), async (req, res) => {
  try {
    const scoreUrl = req.body?.scoreUrl;
    if (typeof scoreUrl !== "string" || !scoreUrl.trim()) {
      return res.status(400).json({ error: "Provide a scoreUrl." });
    }
    const { scoreId } = parseScoreUrl(scoreUrl.trim());
    const score = await getScore(scoreId);

    // osu!standard only (same constraint the render pipeline enforces).
    const rulesetId = score.ruleset_id ?? score.mode_int;
    const isStd = rulesetId === 0 || score.beatmap?.mode === "osu" || score.mode === "osu";
    if (!isStd) {
      return res
        .status(400)
        .json({ error: "whatif only supports osu!standard scores." });
    }

    const st = score.statistics || {};
    // New-API statistics names (great/ok/meh/miss) -> classic 300/100/50/miss.
    const counts = {
      count300: st.great || 0,
      count100: st.ok || 0,
      count50: st.meh || 0,
      countMiss: st.miss || 0,
    };
    const modAcronyms = (score.mods || [])
      .map((m) => (typeof m === "string" ? m : m.acronym))
      .filter(Boolean);
    // "CL" (classic) is a scoring flag, not a difficulty-affecting mod -- drop
    // it from the pp mods and the displayed mod string so it doesn't read as
    // if the player used some extra mod.
    const ppMods = modAcronyms.filter((m) => m !== "CL");

    const beatmapHash = score.beatmap?.checksum;
    if (!beatmapHash) {
      return res.status(422).json({ error: "Score is missing its beatmap checksum; can't resolve the map." });
    }
    const { content, beatmapsetId, source } = await loadBeatmapContentByHash(beatmapHash);

    const set = score.beatmapset || {};
    res.json({
      header: {
        playerName: score.user?.username || `user ${score.user_id}`,
        mode: "osu",
        modsString: ppMods.join(""),
        mods: ppMods,
        counts,
        maxCombo: score.max_combo,
        perfectCombo: Boolean(score.is_perfect_combo ?? score.legacy_perfect),
      },
      beatmap: {
        artist: set.artist ?? "",
        title: set.title ?? "",
        version: score.beatmap?.version ?? "",
      },
      resolvedSource: source,
      beatmapsetId,
      pp: computeSimPp(content, {
        mods: ppMods.join(""),
        counts,
        maxCombo: score.max_combo,
        officialPp: score.pp,
      }),
    });
  } catch (err) {
    console.error("miss-analyzer simulate error:", err);
    res.status(500).json({ error: `Simulation failed: ${err.message}` });
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
