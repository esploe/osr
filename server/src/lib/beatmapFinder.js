// Locates the specific `.osu` file inside an extracted beatmapset that
// matches a given MD5 hash (as recorded in the replay's header). A
// beatmapset zip typically contains several difficulty files -- the hash
// is the only way to pick the exact one the replay was played on.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function findBeatmapFileByHash(beatmapsetDir, targetHash) {
  const wanted = targetHash.toLowerCase();
  for (const entry of walk(beatmapsetDir)) {
    if (!entry.toLowerCase().endsWith(".osu")) continue;
    const buf = fs.readFileSync(entry);
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    if (md5.toLowerCase() === wanted) {
      return { path: entry, content: buf.toString("utf8") };
    }
  }
  return null;
}

function* walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}
