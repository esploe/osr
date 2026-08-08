import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// docker/Dockerfile writes this from `git rev-parse --short HEAD` at build
// time (see the gitinfo stage) -- absent in a plain `node index.js` dev run
// outside Docker, hence the fallback.
const versionFile = path.join(__dirname, "..", "..", "..", "VERSION.txt");

export const VERSION = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, "utf8").trim()
  : "dev";
