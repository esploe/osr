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
  throw new Error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required to start the Discord bot.");
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

await registerCommands();
await client.login(token);
