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
import { getUser, getUserRecentScoreUrl, getUserScoreOnBeatmapUrl } from "./osuApi.js";
import { isScoreBotAuthor, parseScoreBotEmbed } from "./scoreParser.js";
import { runRenderFlow } from "./renderFlow.js";

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

client.once(Events.ClientReady, (c) => {
  console.log(`Discord bot logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "link") {
      const username = interaction.options.getString("username", true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = await getUser(username);
      if (!user) {
        await interaction.editReply(`Couldn't find an osu! user named "${username}".`);
        return;
      }
      setLinkedUsername(interaction.user.id, user.username);
      await interaction.editReply(`Linked to osu! user **${user.username}**.`);
    } else if (interaction.commandName === "unlink") {
      const removed = removeLinkedUsername(interaction.user.id);
      await interaction.reply({
        content: removed ? "Unlinked." : "You weren't linked.",
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error(err);
    const payload = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!client.user || !message.mentions.has(client.user)) return;

    let scoreUrl = null;

    // Mode A: replying to a bathbot/owo score message + mentioning us in
    // that reply -> render the score shown in the message replied to.
    if (message.reference) {
      const referenced = await message.fetchReference().catch(() => null);
      if (referenced && isScoreBotAuthor(referenced.author)) {
        const parsed = parseScoreBotEmbed(referenced);
        if (!parsed) {
          await message.reply(
            "Couldn't read a beatmap/username out of that message -- try pinging me without " +
              "replying to anything to render your last recent score instead."
          );
          return;
        }
        scoreUrl = await getUserScoreOnBeatmapUrl(parsed.username, parsed.beatmapId, parsed.mods);
      }
    }

    // Mode B: just mentioning us (no reply, or a reply to something that
    // isn't a recognized score bot) -> render the pinging user's own most
    // recent score.
    if (!scoreUrl) {
      const osuUsername = getLinkedUsername(message.author.id);
      if (!osuUsername) {
        await message.reply("You haven't linked an osu! account yet -- run `/link <osu username>` first.");
        return;
      }
      scoreUrl = await getUserRecentScoreUrl(osuUsername);
    }

    await runRenderFlow(message, scoreUrl);
  } catch (err) {
    console.error(err);
    await message.reply(`❌ ${err.message}`).catch(() => {});
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
