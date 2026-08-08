import fs from "node:fs";
import path from "node:path";
import { dirs } from "./paths.js";

// Named presets of the render-options form, so re-rendering with "my usual
// settings" doesn't mean re-clicking through every option each time. Kept
// as one small JSON file rather than a database -- this is a single-user
// self-hosted tool, not something that needs real persistence machinery.
const STORE_PATH = path.join(dirs.data, "profiles.json");

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {}; // corrupt/empty file -- treat as no saved profiles rather than crashing
  }
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function listProfiles() {
  return Object.keys(readStore()).sort((a, b) => a.localeCompare(b));
}

export function getProfile(name) {
  return readStore()[name] ?? null;
}

export function saveProfile(name, settings) {
  const store = readStore();
  store[name] = settings;
  writeStore(store);
}

export function deleteProfile(name) {
  const store = readStore();
  if (!(name in store)) return false;
  delete store[name];
  writeStore(store);
  return true;
}
