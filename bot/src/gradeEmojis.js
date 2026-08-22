import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real osu! icons (bathbot-style) via Discord *application emojis* -- uploaded
// once to the application itself (not a guild), so they render in every server
// the bot is in, referenced by <:name:id>. The PNGs are bundled under
// bot/assets so nothing is hotlinked at runtime:
//   grades: osu-web's classic circular grade icons (legacy-ranking-*.png)
//   hits:   osu's default (Legacy) skin hit-result graphics (hit300/100/50/0)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRADES_DIR = path.join(__dirname, "..", "assets", "grades");
const HITS_DIR = path.join(__dirname, "..", "assets", "hits");

// [ key (as used by whatif.js), application-emoji name, absolute PNG path ].
// Grade SS uses osu's "X" icon, S uses "S"; silver (XH/SH) variants aren't
// produced by our grade calc so they're omitted.
const SPECS = [
  ["grade", "SS", "osu_ss", path.join(GRADES_DIR, "X.png")],
  ["grade", "S", "osu_s", path.join(GRADES_DIR, "S.png")],
  ["grade", "A", "osu_a", path.join(GRADES_DIR, "A.png")],
  ["grade", "B", "osu_b", path.join(GRADES_DIR, "B.png")],
  ["grade", "C", "osu_c", path.join(GRADES_DIR, "C.png")],
  ["grade", "D", "osu_d", path.join(GRADES_DIR, "D.png")],
  ["hit", "300", "osu_hit300", path.join(HITS_DIR, "300.png")],
  ["hit", "100", "osu_hit100", path.join(HITS_DIR, "100.png")],
  ["hit", "50", "osu_hit50", path.join(HITS_DIR, "50.png")],
  ["hit", "miss", "osu_hitmiss", path.join(HITS_DIR, "miss.png")],
];

// kind -> { key -> "<:name:id>" }, populated by ensureEmojis().
const markup = { grade: {}, hit: {} };

export function getGradeEmoji(grade) {
  return markup.grade[grade] || null;
}
export function getHitEmoji(kind) {
  return markup.hit[kind] || null;
}

// Idempotent: fetch the application's existing emojis, upload any missing
// PNGs, and cache the markup. Failure is non-fatal -- the embed falls back to
// coloured circles/squares (see whatif.js) if this can't run (e.g. the emoji
// API is unavailable or the app has hit its emoji cap).
export async function ensureEmojis(client) {
  try {
    const existing = await client.application.emojis.fetch();
    const byName = new Map(existing.map((e) => [e.name, e]));
    for (const [kind, key, name, file] of SPECS) {
      let emoji = byName.get(name);
      if (!emoji) {
        const attachment = fs.readFileSync(file);
        emoji = await client.application.emojis.create({ name, attachment });
        console.log(`Uploaded application emoji :${name}:`);
      }
      markup[kind][key] = emoji.toString();
    }
  } catch (err) {
    console.error("Emoji setup failed; using coloured fallback:", err.message);
  }
}
