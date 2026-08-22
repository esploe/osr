import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real osu! grade badges (bathbot-style) via Discord *application emojis* --
// uploaded once to the application itself (not a guild), so they render in
// every server the bot is in, referenced by <:name:id>. The PNGs are the
// classic circular grade icons from osu-web (resources/images/scores/
// legacy-ranking-*.png), bundled under bot/assets/grades so nothing is
// hotlinked at runtime.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, "..", "assets", "grades");

// [ grade letter (from computeAccGrade), application-emoji name, PNG file ].
// SS uses osu's "X" icon, S uses "S"; silver (XH/SH) variants aren't produced
// by our grade calc so they're omitted.
const GRADES = [
  ["SS", "osu_ss", "X.png"],
  ["S", "osu_s", "S.png"],
  ["A", "osu_a", "A.png"],
  ["B", "osu_b", "B.png"],
  ["C", "osu_c", "C.png"],
  ["D", "osu_d", "D.png"],
];

// grade letter -> "<:name:id>" markup, populated by ensureGradeEmojis().
const markup = {};

export function getGradeEmoji(grade) {
  return markup[grade] || null;
}

// Idempotent: fetch the application's existing emojis, upload any missing
// grade PNGs, and cache the markup. Failure is non-fatal -- the embed falls
// back to coloured circles (see whatif.js) if this can't run (e.g. the emoji
// API is unavailable or the app has hit its emoji cap).
export async function ensureGradeEmojis(client) {
  try {
    const existing = await client.application.emojis.fetch();
    const byName = new Map(existing.map((e) => [e.name, e]));
    for (const [grade, name, file] of GRADES) {
      let emoji = byName.get(name);
      if (!emoji) {
        const attachment = fs.readFileSync(path.join(ASSET_DIR, file));
        emoji = await client.application.emojis.create({ name, attachment });
        console.log(`Uploaded grade application emoji :${name}:`);
      }
      markup[grade] = emoji.toString();
    }
  } catch (err) {
    console.error("Grade emoji setup failed; using coloured-circle fallback:", err.message);
  }
}
