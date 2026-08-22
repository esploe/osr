import { EmbedBuilder } from "discord.js";

// Shared colours so every bot reply reads as one visual family. osu! pink
// for neutral/info, standard Discord status colours for the rest.
export const COLOR_INFO = 0xff66ab;
export const COLOR_SUCCESS = 0x57f287;
export const COLOR_ERROR = 0xed4245;
export const COLOR_PROGRESS = 0xfaa61a;

export const infoEmbed = (desc) => new EmbedBuilder().setColor(COLOR_INFO).setDescription(desc);
export const successEmbed = (desc) => new EmbedBuilder().setColor(COLOR_SUCCESS).setDescription(desc);
export const errorEmbed = (desc) => new EmbedBuilder().setColor(COLOR_ERROR).setDescription(`❌ ${desc}`);
export const progressEmbed = (desc) => new EmbedBuilder().setColor(COLOR_PROGRESS).setDescription(desc);

export function helpEmbed(prefix) {
  return new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setTitle("osu! replay renderer bot")
    .setDescription(
      [
        `\`${prefix}render [score url]\` — render a replay to video`,
        `\`${prefix}whatif [score url]\` — score & no-miss simulation (no video)`,
        `\`${prefix}link <osu username>\` — link your osu! account`,
        `\`${prefix}unlink\` — remove your linked account`,
        "",
        "With no score URL, both `render` and `whatif` use the score in the " +
          "message you're replying to (bathbot/owo), or your own most recent play.",
        "You can also **@mention** the bot instead of using the prefix.",
      ].join("\n")
    );
}
