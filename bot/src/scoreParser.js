// Best-effort parsing of bathbot/owo-style score embeds. These bots don't
// embed a stable per-score URL (there's no clickable "view this score"
// link in their recent-play embeds as far as could be determined without
// live access to one), only a beatmap link plus the player's name in the
// embed author field -- so we extract those two things and let the caller
// resolve the actual score via the osu! API (beatmap + user -> score),
// rather than trying to scrape score details out of embed text directly.
//
// NOT tested against live bathbot/owo output (no Discord server available
// to verify against in the environment this was written in). If matching
// misfires in practice, paste a real embed's raw JSON (right-click message
// in Discord dev mode, or log `message.embeds[0].toJSON()`) and adjust the
// extractors below against it.
const BEATMAP_URL_RE =
  /osu\.ppy\.sh\/beatmapsets\/\d+#(?:osu|taiko|fruits|mania)\/(\d+)|osu\.ppy\.sh\/beatmaps\/(\d+)|osu\.ppy\.sh\/b\/(\d+)/i;

const MODS_RE = /\+([A-Z]{2}(?:[A-Z]{2})*)\b/;

const SCORE_BOT_NAME_HINTS = ["bathbot", "owo"];

export function isScoreBotAuthor(author) {
  if (!author?.bot) return false;
  const configured = (process.env.SCORE_BOT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured.includes(author.id);
  const name = (author.username || "").toLowerCase();
  return SCORE_BOT_NAME_HINTS.some((hint) => name.includes(hint));
}

function extractBeatmapId(embed) {
  const haystacks = [
    embed.url,
    embed.author?.url,
    embed.title,
    embed.description,
    ...(embed.fields || []).map((f) => f.value),
  ].filter(Boolean);
  for (const text of haystacks) {
    const m = text.match(BEATMAP_URL_RE);
    if (m) return Number(m[1] || m[2] || m[3]);
  }
  return null;
}

function extractUsername(embed) {
  const raw = embed.author?.name;
  if (!raw) return null;
  // Strip common trailing decoration, e.g. "Username - Recent #1", "Username | osu!".
  const cleaned = raw.split(/[-|•·]/)[0].trim();
  return cleaned || null;
}

function extractMods(embed) {
  const text = [embed.title, embed.description].filter(Boolean).join(" ");
  const m = text.match(MODS_RE);
  return m ? m[1] : null;
}

export function parseScoreBotEmbed(message) {
  const embed = message.embeds?.[0];
  if (!embed) return null;
  const beatmapId = extractBeatmapId(embed);
  const username = extractUsername(embed);
  if (!beatmapId || !username) return null;
  return { beatmapId, username, mods: extractMods(embed) };
}
