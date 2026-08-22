import { EmbedBuilder } from "discord.js";
import { COLOR_INFO } from "./embeds.js";
import { getGradeEmoji } from "./gradeEmojis.js";

// osu!standard accuracy + letter grade from a judgement breakdown. Ported
// verbatim from web/app.js#computeAccGrade so the embed matches the web
// miss-analyzer's "Score & simulation" panel exactly.
function computeAccGrade(n300, n100, n50, n0) {
  const total = n300 + n100 + n50 + n0;
  if (total === 0) return { acc: 100, grade: "SS" };
  const acc = ((300 * n300 + 100 * n100 + 50 * n50) / (300 * total)) * 100;
  const r300 = n300 / total;
  const r50 = n50 / total;
  let grade;
  if (n100 === 0 && n50 === 0 && n0 === 0) grade = "SS";
  else if (r300 > 0.9 && r50 < 0.01 && n0 === 0) grade = "S";
  else if ((r300 > 0.8 && n0 === 0) || r300 > 0.9) grade = "A";
  else if ((r300 > 0.7 && n0 === 0) || r300 > 0.8) grade = "B";
  else if (r300 > 0.6) grade = "C";
  else grade = "D";
  return { acc, grade };
}

// Grade badge: prefer the real osu! grade icon (uploaded as an application
// emoji, which already contains the letter) and fall back to an osu-coloured
// circle + letter if the emoji isn't available (upload failed / not ready).
const GRADE_CIRCLE = { SS: "🟡", S: "🟡", A: "🟢", B: "🔵", C: "🟣", D: "🔴" };
function gradeBadge(g) {
  const emoji = getGradeEmoji(g);
  return emoji || `${GRADE_CIRCLE[g] || "⚪"} **${g}**`;
}

// osu!'s star-rating difficulty spectrum (star value -> colour). Used to tint
// the embed's accent bar the same colour the game would give this map's
// difficulty, so harder maps read hotter at a glance.
const STAR_STOPS = [
  [0.1, 0x4290fb], [1.25, 0x4fc0ff], [2.0, 0x4fffd5], [2.5, 0x7cff4f],
  [3.3, 0xf6f05c], [4.2, 0xff8068], [4.9, 0xff4e6f], [5.8, 0xc645b8],
  [6.7, 0x6563de], [7.7, 0x18158e], [9.0, 0x000000],
];
function lerpColor(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
function starColor(stars) {
  if (stars == null) return COLOR_INFO;
  if (stars <= STAR_STOPS[0][0]) return STAR_STOPS[0][1];
  const last = STAR_STOPS[STAR_STOPS.length - 1];
  if (stars >= last[0]) return last[1];
  for (let i = 0; i < STAR_STOPS.length - 1; i++) {
    const [s0, c0] = STAR_STOPS[i];
    const [s1, c1] = STAR_STOPS[i + 1];
    if (stars >= s0 && stars <= s1) return lerpColor(c0, c1, (stars - s0) / (s1 - s0));
  }
  return COLOR_INFO;
}

const ppStr = (v) => (v != null ? `**${v.toFixed(2)}**pp` : null);

// Turns the coordinator's /api/miss-analyzer/simulate-url JSON into the same
// "this play vs. no misses" simulation the web UI renders, as a Discord
// embed. `data` is the full response { header, beatmap, pp, beatmapsetId }.
export function buildWhatifEmbed(data) {
  const { header, beatmap, pp, beatmapsetId } = data;
  const c = header.counts;
  const cur = computeAccGrade(c.count300, c.count100, c.count50, c.countMiss);
  const sim = computeAccGrade(c.count300 + c.countMiss, c.count100, c.count50, 0);
  const accDelta = sim.acc - cur.acc;
  const ppDelta = pp && pp.current != null && pp.fc != null ? pp.fc - pp.current : null;
  const noMisses = c.countMiss === 0;

  const thisPlay = [
    `${gradeBadge(cur.grade)} · ${cur.acc.toFixed(2)}%`,
    ppStr(pp?.current),
    `${header.maxCombo}× combo`,
  ].filter(Boolean).join("\n");

  // Delta line under the no-miss column: acc/pp gained by not missing, or a
  // plain note when the play already has no misses (nothing to recover).
  const noMissSub = noMisses
    ? "already no misses"
    : [
        accDelta >= 0.005 ? `+${accDelta.toFixed(2)}%` : "same acc",
        ppDelta != null && ppDelta >= 0.01 ? `+${ppDelta.toFixed(2)}pp` : "",
      ].filter(Boolean).join(" · ");
  const noMiss = [
    `${gradeBadge(sim.grade)} · ${sim.acc.toFixed(2)}%`,
    ppStr(pp?.fc),
    `*${noMissSub}*`,
  ].filter(Boolean).join("\n");

  // Hit breakdown as its own column, colour-coded with osu's judgement
  // colours (300 blue, 100 green, 50 gold, miss red) so it reads at a glance
  // instead of a lonely row of slash-separated numbers.
  const hits = [
    `🟦 \`${c.count300}\``,
    `🟩 \`${c.count100}\``,
    `🟨 \`${c.count50}\``,
    `🟥 \`${c.countMiss}\``,
  ].join("\n");

  const modLine = header.modsString ? `\`+${header.modsString}\`` : "`No mod`";
  const starLine = pp?.stars != null ? `⭐ **${pp.stars.toFixed(2)}**` : null;

  const embed = new EmbedBuilder()
    .setColor(starColor(pp?.stars))
    .setAuthor({ name: header.playerName })
    .setTitle(`${beatmap.artist} - ${beatmap.title} [${beatmap.version}]`)
    .setDescription([modLine, starLine].filter(Boolean).join("  ·  "))
    .addFields(
      { name: "This play", value: thisPlay, inline: true },
      { name: "If no misses", value: noMiss, inline: true },
      { name: "Hits", value: hits, inline: true }
    )
    .setFooter({
      text: noMisses
        ? "This play already has no misses."
        : `Recovers all ${c.countMiss} miss${c.countMiss === 1 ? "" : "es"} as 300s — an upper bound on acc & pp.`,
    });

  if (beatmapsetId) {
    embed.setURL(`https://osu.ppy.sh/beatmapsets/${beatmapsetId}`);
    embed.setThumbnail(`https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list@2x.jpg`);
  }

  return embed;
}
