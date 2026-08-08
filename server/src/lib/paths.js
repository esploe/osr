import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";

export const dirs = {
  data: DATA_DIR,
  uploads: path.join(DATA_DIR, "uploads"),
  songs: path.join(DATA_DIR, "songs"),
  skins: path.join(DATA_DIR, "skins"),
  output: path.join(DATA_DIR, "output"),
  danserSettings: path.join(DATA_DIR, "danser-settings"),
};

for (const d of Object.values(dirs)) {
  fs.mkdirSync(d, { recursive: true });
}
