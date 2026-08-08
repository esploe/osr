import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import fetch from "node-fetch";

// Single place to fix if a mirror changes its API shape -- everything else
// in this file just calls these two functions.
const MIRRORS = {
  osuDirect: {
    // The /set variant resolves straight to the beatmapset (with
    // Artist/Title/SetID) instead of just the single matching difficulty.
    lookupByHash: (hash) => `https://osu.direct/api/md5/${hash}/set`,
    downloadSet: (beatmapsetId) => `https://osu.direct/api/d/${beatmapsetId}`,
  },
  nerinyan: {
    lookupByHash: (hash) => `https://api.nerinyan.moe/search?md5=${hash}`,
    downloadSet: (beatmapsetId) => `https://api.nerinyan.moe/d/${beatmapsetId}`,
  },
};

async function tryJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "osu-replay-renderer/0.1" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Resolve a beatmap MD5 hash (as found in a replay header) to a beatmapset id
 * and the specific difficulty's metadata, trying mirrors in order.
 */
export async function resolveBeatmapByHash(hash) {
  const errors = [];

  try {
    const set = await tryJson(MIRRORS.osuDirect.lookupByHash(hash));
    if (set?.SetID) {
      const diff = set.ChildrenBeatmaps?.find((b) => b.FileMD5 === hash);
      return {
        source: "osu.direct",
        beatmapsetId: set.SetID,
        beatmapId: diff?.BeatmapID,
        version: diff?.DiffName,
        artist: set.Artist,
        title: set.Title,
      };
    }
  } catch (err) {
    errors.push(`osu.direct: ${err.message}`);
  }

  try {
    const data = await tryJson(MIRRORS.nerinyan.lookupByHash(hash));
    const beatmap = Array.isArray(data) ? data[0] : data;
    if (beatmap?.beatmapset_id) {
      return {
        source: "nerinyan",
        beatmapsetId: beatmap.beatmapset_id,
        beatmapId: beatmap.id,
        version: beatmap.version,
        artist: beatmap.beatmapset?.artist,
        title: beatmap.beatmapset?.title,
      };
    }
  } catch (err) {
    errors.push(`nerinyan: ${err.message}`);
  }

  throw new Error(`Could not resolve beatmap for hash ${hash}: ${errors.join("; ")}`);
}

/**
 * Downloads and extracts a beatmapset (.osz) into songsDir/<beatmapsetId>/,
 * matching the folder layout danser-go (and osu!) expect under Songs/.
 * No-ops if the folder already exists (cache across renders).
 */
export async function ensureBeatmapsetDownloaded(beatmapsetId, songsDir, { log = () => {} } = {}) {
  const destDir = path.join(songsDir, String(beatmapsetId));
  if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
    log(`Beatmapset ${beatmapsetId} already cached, skipping download.`);
    return destDir;
  }
  fs.mkdirSync(destDir, { recursive: true });

  const mirrorOrder = [MIRRORS.osuDirect, MIRRORS.nerinyan];
  let lastErr;
  for (const mirror of mirrorOrder) {
    const url = mirror.downloadSet(beatmapsetId);
    try {
      log(`Downloading beatmapset ${beatmapsetId} from ${url}`);
      const res = await fetch(url, { headers: { "User-Agent": "osu-replay-renderer/0.1" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(res.body, unzipper.Extract({ path: destDir }));
      log(`Extracted beatmapset ${beatmapsetId} to ${destDir}`);
      return destDir;
    } catch (err) {
      lastErr = err;
      log(`Mirror failed (${url}): ${err.message}`);
    }
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  throw new Error(`Failed to download beatmapset ${beatmapsetId} from any mirror: ${lastErr?.message}`);
}
