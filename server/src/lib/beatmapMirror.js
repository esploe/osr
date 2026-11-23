import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import fetch from "node-fetch";

const UA = { "User-Agent": "osu-replay-renderer/0.1" };

// Single place to fix if a mirror changes its API shape -- everything else
// in this file just calls these functions.
const MIRRORS = {
  osuDirect: {
    // The /set variant resolves straight to the beatmapset (with
    // Artist/Title/SetID) instead of just the single matching difficulty.
    lookupByHash: (hash) => `https://osu.direct/api/md5/${hash}/set`,
    lookupSingleByHash: (hash) => `https://osu.direct/api/md5/${hash}`,
    downloadSet: (beatmapsetId) => `https://osu.direct/api/d/${beatmapsetId}`,
  },
  catboy: {
    downloadSet: (beatmapsetId) => `https://catboy.best/d/${beatmapsetId}`,
  },
  nerinyan: {
    lookupByHash: (hash) => `https://api.nerinyan.moe/search?md5=${hash}`,
    downloadSet: (beatmapsetId) => `https://api.nerinyan.moe/d/${beatmapsetId}`,
  },
};

// Tried in order. A mirror can serve an .osz that predates a later update of
// the set (or vice versa), so a successful download is only accepted if it
// actually contains the exact difficulty hash the replay was played on.
const SET_MIRRORS = [MIRRORS.osuDirect, MIRRORS.catboy, MIRRORS.nerinyan];

// Single-difficulty .osu sources by beatmap id -- used to patch in the exact
// difficulty when no full-set download carries the right version of it.
const SINGLE_OSU_SOURCES = [
  (beatmapId) => `https://osu.ppy.sh/osu/${beatmapId}`,
  (beatmapId) => `https://catboy.best/osu/${beatmapId}`,
  (beatmapId) => `https://osu.direct/api/osu/${beatmapId}`,
];

async function tryJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex");

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
 * Whether `dir` holds a top-level .osu file whose MD5 is `hash` -- the exact
 * check danser itself uses to match a replay to a difficulty.
 */
export function setHasHash(dir, hash) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) => e.isFile() && e.name.toLowerCase().endsWith(".osu") && md5(fs.readFileSync(path.join(dir, e.name))) === hash,
  );
}

async function downloadSetInto(url, dir) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.mkdirSync(dir, { recursive: true });
  await pipeline(res.body, unzipper.Extract({ path: dir }));
}

function replaceDir(fromDir, toDir) {
  fs.rmSync(toDir, { recursive: true, force: true });
  fs.renameSync(fromDir, toDir);
}

async function findBeatmapIdForHash(hash) {
  const single = await tryJson(MIRRORS.osuDirect.lookupSingleByHash(hash));
  return single?.BeatmapID;
}

/**
 * Fetch the single exact-hash .osu by beatmap id and write it into `dir`,
 * replacing a stale copy of the same difficulty (matched by its BeatmapID
 * header line) if there is one. Returns true on success.
 */
async function patchSingleOsu(dir, { beatmapHash, beatmapId, log }) {
  if (!beatmapId) {
    try {
      beatmapId = await findBeatmapIdForHash(beatmapHash);
    } catch (err) {
      log(`Could not look up beatmap id for ${beatmapHash}: ${err.message}`);
    }
  }
  if (!beatmapId) return false;

  for (const source of SINGLE_OSU_SOURCES) {
    const url = source(beatmapId);
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (md5(buf) !== beatmapHash) {
        log(`${url} served a different version of the difficulty (md5 ${md5(buf)}), skipping.`);
        continue;
      }
      const idLine = new RegExp(`^BeatmapID:\\s*${beatmapId}\\s*$`, "m");
      const stale = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".osu"))
        .find((f) => idLine.test(fs.readFileSync(path.join(dir, f), "utf8")));
      const target = path.join(dir, stale || `${beatmapId}.osu`);
      fs.writeFileSync(target, buf);
      log(`Patched in exact difficulty ${beatmapHash} from ${url} -> ${path.basename(target)}`);
      return true;
    } catch (err) {
      log(`Single-difficulty source failed (${url}): ${err.message}`);
    }
  }
  return false;
}

/**
 * Downloads and extracts a beatmapset (.osz) into songsDir/<beatmapsetId>/,
 * matching the folder layout danser-go (and osu!) expect under Songs/.
 *
 * A cached folder is reused only if it contains the exact difficulty the
 * replay needs (`beatmapHash`). Beatmapsets get updated after release, so a
 * folder cached by an earlier render can hold an older version of a
 * difficulty -- danser matches replays by exact MD5 and would just print
 * "Beatmap not found". In that case the set is re-downloaded, preferring a
 * mirror whose copy actually contains the hash, and as a last resort the
 * single exact .osu is patched in from osu.ppy.sh / a mirror.
 */
export async function ensureBeatmapsetDownloaded(beatmapsetId, songsDir, { log = () => {}, beatmapHash, beatmapId } = {}) {
  const destDir = path.join(songsDir, String(beatmapsetId));
  const cached = fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0;
  if (cached) {
    if (!beatmapHash || setHasHash(destDir, beatmapHash)) {
      log(`Beatmapset ${beatmapsetId} already cached, skipping download.`);
      return destDir;
    }
    log(`Cached beatmapset ${beatmapsetId} is stale (no difficulty with hash ${beatmapHash}) -- re-downloading.`);
  }

  const tmpDir = `${destDir}.tmp-${process.pid}-${Date.now()}`;
  let lastErr;
  let anyDownloaded = false;
  let fallbackDir = null; // a successful download that lacks the hash
  try {
    for (const mirror of SET_MIRRORS) {
      const url = mirror.downloadSet(beatmapsetId);
      const attemptDir = `${tmpDir}-${SET_MIRRORS.indexOf(mirror)}`;
      try {
        log(`Downloading beatmapset ${beatmapsetId} from ${url}`);
        await downloadSetInto(url, attemptDir);
        anyDownloaded = true;
        if (!beatmapHash || setHasHash(attemptDir, beatmapHash)) {
          replaceDir(attemptDir, destDir);
          log(`Extracted beatmapset ${beatmapsetId} to ${destDir}`);
          return destDir;
        }
        log(`${url} has a different version of this set (no difficulty with hash ${beatmapHash}), trying next mirror.`);
        if (fallbackDir) fs.rmSync(fallbackDir, { recursive: true, force: true });
        fallbackDir = attemptDir;
      } catch (err) {
        lastErr = err;
        fs.rmSync(attemptDir, { recursive: true, force: true });
        log(`Mirror failed (${url}): ${err.message}`);
      }
    }

    // No full set carried the exact difficulty. Patch the single .osu into
    // the best set we have (a fresh download, else the stale cache) so audio,
    // background and storyboard still come from the set.
    const baseDir = fallbackDir || (cached ? destDir : null);
    if (baseDir && beatmapHash && (await patchSingleOsu(baseDir, { beatmapHash, beatmapId, log }))) {
      if (baseDir !== destDir) replaceDir(baseDir, destDir);
      fallbackDir = null;
      return destDir;
    }
  } finally {
    if (fallbackDir) fs.rmSync(fallbackDir, { recursive: true, force: true });
  }

  if (!cached && !anyDownloaded) {
    throw new Error(`Failed to download beatmapset ${beatmapsetId} from any mirror: ${lastErr?.message}`);
  }
  throw new Error(
    `No mirror or osu.ppy.sh has the exact version of this difficulty the replay was played on (hash ${beatmapHash}) -- ` +
      `the beatmap was most likely updated after this play, so the replay can't be matched to it.`,
  );
}
