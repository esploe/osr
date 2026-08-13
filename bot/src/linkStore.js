import fs from "node:fs";
import path from "node:path";

// discordUserId -> osu! username, so "@bot" with no reply target knows
// whose recent score to render. One small JSON file, same pattern as the
// coordinator's lib/profiles.js -- this is a single-user/small-server bot,
// not something that needs real persistence machinery.
const DATA_DIR = process.env.BOT_DATA_DIR || "/data";
const STORE_PATH = path.join(DATA_DIR, "links.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {}; // corrupt/empty file -- treat as no links rather than crashing
  }
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function getLinkedUsername(discordId) {
  return readStore()[discordId] ?? null;
}

export function setLinkedUsername(discordId, osuUsername) {
  const store = readStore();
  store[discordId] = osuUsername;
  writeStore(store);
}

export function removeLinkedUsername(discordId) {
  const store = readStore();
  if (!(discordId in store)) return false;
  delete store[discordId];
  writeStore(store);
  return true;
}
