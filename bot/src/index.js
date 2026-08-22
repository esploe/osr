import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { getLinkedUsername, setLinkedUsername, removeLinkedUsername } from "./linkStore.js";
import { getUserPrefs, setUserPref, clearUserPrefs } from "./prefsStore.js";
import { getUser, getUserRecentScoreUrl, getUserScoreOnBeatmapUrl } from "./osuApi.js";
import { isScoreBotAuthor, parseScoreBotEmbed } from "./scoreParser.js";
import { runRenderFlow } from "./renderFlow.js";
import { listSkins, simulateScoreUrl } from "./renderClient.js";
import { buildWhatifEmbed } from "./whatif.js";
import { ensureGradeEmojis } from "./gradeEmojis.js";
import { infoEmbed, successEmbed, errorEmbed, progressEmbed, helpEmbed } from "./embeds.js";

// Text-command prefix (e.g. ".render", ".whatif"). Mentioning the bot still
// works as an alias for these too.
const PREFIX = process.env.BOT_PREFIX || ".";

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required to start the Discord bot.");
  process.exit(1);
}
if (!process.env.COORDINATOR_URL) {
  // Matches server/src/worker.js's own fail-loud check -- the bot has no
  // same-machine default to fall back to (see renderClient.js).
  console.error("COORDINATOR_URL is required (e.g. http://<coordinator LAN IP>:8080).");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to an osu! username")
    .addStringOption((opt) => opt.setName("username").setDescription("Your osu! username").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove your linked osu! username")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Your per-user render preferences for this bot")
    .addSubcommand((sub) =>
      sub
        .setName("skin")
        .setDescription("Set the skin used for your renders")
        .addStringOption((opt) =>
          opt
            .setName("skin")
            .setDescription("Start typing to search available skins")
            .setAutocomplete(true)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName("show").setDescription("Show your current render preferences"))
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Clear your render preferences (reverts to the bot's default)")
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST().setToken(token);
  // Guild-scoped registration shows up instantly (good for a single-server
  // bot); global registration works everywhere the bot is invited but can
  // take up to an hour to propagate after the first deploy.
  const route = process.env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(clientId, process.env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Discord bot logged in as ${c.user.tag}`);
  // Upload the osu! grade badges as application emojis (once) so .whatif can
  // show real grade icons instead of coloured circles.
  await ensureGradeEmojis(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    // Fires as the user types in an autocomplete-enabled option. Discord's
    // hard limit is 25 suggestions per response; the coordinator's own skin
    // list is capped implicitly by whatever the user has uploaded, so we
    // filter + slice rather than paginate. Errors here are swallowed
    // (respond with []) because Discord treats an unresponded autocomplete
    // as an error banner in the UI, which is noisier than an empty list.
    if (interaction.commandName === "settings") {
      const focused = interaction.options.getFocused(true);
      if (focused.name === "skin") {
        try {
          const skins = await listSkins();
          const q = focused.value.toLowerCase();
          const matches = skins
            .filter((s) => s.name.toLowerCase().includes(q))
            .slice(0, 25)
            .map((s) => ({ name: s.name, value: s.id }));
          await interaction.respond(matches);
        } catch (err) {
          console.error("skin autocomplete failed:", err.message);
          await interaction.respond([]).catch(() => {});
        }
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "link") {
      const username = interaction.options.getString("username", true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = await getUser(username);
      if (!user) {
        await interaction.editReply({ embeds: [errorEmbed(`Couldn't find an osu! user named "${username}".`)] });
        return;
      }
      setLinkedUsername(interaction.user.id, user.username);
      await interaction.editReply({ embeds: [successEmbed(`Linked to osu! user **${user.username}**.`)] });
    } else if (interaction.commandName === "unlink") {
      const removed = removeLinkedUsername(interaction.user.id);
      await interaction.reply({
        embeds: [infoEmbed(removed ? "Unlinked." : "You weren't linked.")],
        flags: MessageFlags.Ephemeral,
      });
    } else if (interaction.commandName === "settings") {
      await handleSettingsCommand(interaction);
    }
  } catch (err) {
    console.error(err);
    const payload = { embeds: [errorEmbed(err.message)], flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

async function handleSettingsCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "skin") {
    const skinId = interaction.options.getString("skin", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Re-validate against the live skin list rather than trusting the raw
    // string -- Discord's autocomplete is UX-only, not a validation gate
    // (a user can free-type anything into the field).
    const skins = await listSkins();
    const chosen = skins.find((s) => s.id === skinId);
    if (!chosen) {
      await interaction.editReply(
        `\`${skinId}\` isn't a currently-available skin. Pick one from the autocomplete list.`
      );
      return;
    }
    setUserPref(interaction.user.id, "skin", chosen.id);
    await interaction.editReply({ embeds: [successEmbed(`Skin set to **${chosen.name}** for your future renders.`)] });
  } else if (sub === "show") {
    const prefs = getUserPrefs(interaction.user.id);
    const lines = [];
    if (prefs.skin) lines.push(`Skin: \`${prefs.skin}\``);
    await interaction.reply({
      embeds: [infoEmbed(lines.length ? lines.join("\n") : "You haven't set any render preferences yet.")],
      flags: MessageFlags.Ephemeral,
    });
  } else if (sub === "clear") {
    const cleared = clearUserPrefs(interaction.user.id);
    await interaction.reply({
      embeds: [infoEmbed(cleared ? "Cleared your render preferences." : "You didn't have any preferences set.")],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// Figure out which command + args a message is invoking, or null if it's
// not aimed at the bot. Two entry styles, both handled here:
//   - prefix:  ".render <args>", ".whatif", ".link name", ".help"
//   - mention: "@bot [whatif] [args]" (bare mention defaults to render)
function parseCommand(message) {
  const content = (message.content || "").trim();

  if (content.startsWith(PREFIX) && content.length > PREFIX.length) {
    const rest = content.slice(PREFIX.length).trim();
    const sp = rest.search(/\s/);
    const command = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
    const args = sp === -1 ? "" : rest.slice(sp).trim();
    return { command, args };
  }

  if (client.user && message.mentions.has(client.user)) {
    const stripped = content.replace(/<@!?\d+>/g, "").trim();
    const first = stripped.split(/\s+/)[0]?.toLowerCase() || "";
    // A leading "render"/"whatif" keyword after the mention selects the
    // command; anything else (or nothing) defaults to render, preserving
    // the original bare-mention behaviour.
    if (first === "whatif" || first === "render") {
      return { command: first, args: stripped.slice(first.length).trim() };
    }
    return { command: "render", args: stripped };
  }

  return null;
}

// Resolve the score to act on, in priority order: an explicit osu! score
// URL in the args, then a replied-to bathbot/owo embed, then the caller's
// own most recent play. Replies (via an error embed) and returns null when
// it can't resolve one -- callers just return on null.
async function resolveScoreUrl(message, args) {
  const urlMatch = args && args.match(/https?:\/\/osu\.ppy\.sh\/\S+/i);
  if (urlMatch) return urlMatch[0];

  if (message.reference) {
    const referenced = await message.fetchReference().catch(() => null);
    if (referenced && isScoreBotAuthor(referenced.author)) {
      const parsed = parseScoreBotEmbed(referenced);
      if (!parsed) {
        await message.reply({
          embeds: [
            errorEmbed(
              "Couldn't read a beatmap/username out of that message -- try the command without " +
                "replying to anything to use your last recent score instead."
            ),
          ],
        });
        return null;
      }
      return await getUserScoreOnBeatmapUrl(parsed.username, parsed.beatmapId, parsed.mods);
    }
  }

  const osuUsername = getLinkedUsername(message.author.id);
  if (!osuUsername) {
    await message.reply({
      embeds: [
        errorEmbed(`You haven't linked an osu! account yet -- run \`${PREFIX}link <osu username>\` first.`),
      ],
    });
    return null;
  }
  return await getUserRecentScoreUrl(osuUsername);
}

async function runWhatifFlow(message, scoreUrl) {
  const status = await message.reply({ embeds: [progressEmbed(`🔍 Analyzing: ${scoreUrl}`)] });
  const data = await simulateScoreUrl(scoreUrl);
  await status.edit({ embeds: [buildWhatifEmbed(data)] });
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const parsed = parseCommand(message);
  if (!parsed) return;
  const { command, args } = parsed;

  try {
    if (command === "render" || command === "whatif") {
      const scoreUrl = await resolveScoreUrl(message, args);
      if (!scoreUrl) return; // resolveScoreUrl already replied with the reason
      if (command === "whatif") await runWhatifFlow(message, scoreUrl);
      else await runRenderFlow(message, scoreUrl);
    } else if (command === "link") {
      const username = args.trim();
      if (!username) {
        await message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}link <osu username>\``)] });
        return;
      }
      const user = await getUser(username);
      if (!user) {
        await message.reply({ embeds: [errorEmbed(`Couldn't find an osu! user named "${username}".`)] });
        return;
      }
      setLinkedUsername(message.author.id, user.username);
      await message.reply({ embeds: [successEmbed(`Linked to osu! user **${user.username}**.`)] });
    } else if (command === "unlink") {
      const removed = removeLinkedUsername(message.author.id);
      await message.reply({ embeds: [infoEmbed(removed ? "Unlinked." : "You weren't linked.")] });
    } else if (command === "help") {
      await message.reply({ embeds: [helpEmbed(PREFIX)] });
    }
    // Unknown prefix commands are ignored silently to avoid replying to
    // every stray message that happens to start with the prefix character.
  } catch (err) {
    console.error(err);
    await message.reply({ embeds: [errorEmbed(err.message)] }).catch(() => {});
  }
});

// A bad DISCORD_BOT_TOKEN surfaces here as a 401 from Discord's REST API,
// which by default throws a raw DiscordAPIError stack -- catch it and print
// a diagnosable message instead, since the real cause (wrong token, token
// belongs to a different application than DISCORD_CLIENT_ID, or the value
// in .env has stray whitespace/newlines) isn't obvious from the stack.
try {
  await registerCommands();
  await client.login(token);
} catch (err) {
  if (err?.status === 401) {
    console.error(
      "Discord rejected the bot credentials (HTTP 401). Likely causes:\n" +
        "  - DISCORD_BOT_TOKEN in .env doesn't match the token in the Developer Portal\n" +
        "    (or the token was reset in the portal after .env was written).\n" +
        "  - DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID belong to different applications.\n" +
        "  - The value in .env has stray quotes/whitespace/newlines around it.\n" +
        "Reset the token in the Developer Portal's Bot tab, paste the new value\n" +
        "verbatim (no quotes) into .env, and restart."
    );
    process.exit(1);
  }
  throw err;
}
