import fs from "node:fs";
import path from "node:path";

// Per-user render prefs, currently just { skin: "<skinId>" } but shaped to
// take more keys as they're added. Kept separate from linkStore.js
// (osu-username-only) on purpose -- an existing links.json on disk stays a
// plain string map, no migration needed, and the two stores are independent.
const DATA_DIR = process.env.BOT_DATA_DIR || "/data";
const STORE_PATH = path.join(DATA_DIR, "prefs.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function getUserPrefs(discordId) {
  return readStore()[discordId] || {};
}

export function setUserPref(discordId, key, value) {
  const store = readStore();
  store[discordId] = { ...(store[discordId] || {}), [key]: value };
  writeStore(store);
}

export function clearUserPrefs(discordId) {
  const store = readStore();
  if (!(discordId in store)) return false;
  delete store[discordId];
  writeStore(store);
  return true;
}
