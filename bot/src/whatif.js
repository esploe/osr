import { EmbedBuilder } from "discord.js";
import { COLOR_INFO } from "./embeds.js";

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

// Turns the coordinator's /api/miss-analyzer/analyze-url JSON into the same
// "this play vs. no misses" simulation the web UI renders, as a Discord
// embed. `data` is the full analyzer response { header, beatmap, pp, ... }.
export function buildWhatifEmbed(data) {
  const { header, beatmap, pp } = data;
  const c = header.counts;
  const cur = computeAccGrade(c.count300, c.count100, c.count50, c.countMiss);
  const sim = computeAccGrade(c.count300 + c.countMiss, c.count100, c.count50, 0);
  const accDelta = sim.acc - cur.acc;
  const ppDelta = pp && pp.current != null && pp.fc != null ? pp.fc - pp.current : null;

  const thisPlay = [
    `**${cur.grade}** · **${cur.acc.toFixed(2)}%**`,
    pp?.current != null ? `**${pp.current.toFixed(0)}** pp` : null,
    `${header.maxCombo}× combo`,
  ].filter(Boolean).join("\n");

  const noMissSub = [
    accDelta >= 0.005 ? `+${accDelta.toFixed(2)}%` : "same acc",
    ppDelta != null && ppDelta >= 0.5 ? `+${ppDelta.toFixed(0)}pp` : "",
  ].filter(Boolean).join(" · ");
  const noMiss = [
    `**${sim.grade}** · **${sim.acc.toFixed(2)}%**`,
    pp?.fc != null ? `**${pp.fc.toFixed(0)}** pp` : null,
    noMissSub,
  ].filter(Boolean).join("\n");

  const breakdown = [
    `\`${c.count300}\` 300`,
    `\`${c.count100}\` 100`,
    `\`${c.count50}\` 50`,
    `\`${c.countMiss}\` miss`,
    pp?.stars != null ? `★ ${pp.stars.toFixed(2)}` : null,
  ].filter(Boolean).join("   ");

  const embed = new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setAuthor({ name: header.playerName })
    .setTitle(`${beatmap.artist} - ${beatmap.title} [${beatmap.version}]`)
    .setDescription(`**Score & simulation**  ·  mods **${header.modsString || "None"}**`)
    .addFields(
      { name: "This play", value: thisPlay, inline: true },
      { name: "→ No misses", value: noMiss, inline: true },
      { name: "​", value: breakdown, inline: false }
    )
    .setFooter({
      text:
        `Recovers all ${c.countMiss} miss${c.countMiss === 1 ? "" : "es"} as 300s — an upper bound on the ` +
        `accuracy${pp ? " and pp" : ""} this play could have reached.`,
    });

  return embed;
}
