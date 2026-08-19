import fetch from "node-fetch";

const TOKEN_URL = "https://osu.ppy.sh/oauth/token";
const API_BASE = "https://osu.ppy.sh/api/v2";

let cachedToken = null; // { token, expiresAt }

export function isConfigured() {
  return Boolean(process.env.OSU_CLIENT_ID && process.env.OSU_CLIENT_SECRET);
}

async function getToken() {
  if (!isConfigured()) {
    throw new Error(
      "osu! API credentials not configured. Set OSU_CLIENT_ID and OSU_CLIENT_SECRET in .env " +
        "(create an OAuth client at https://osu.ppy.sh/home/account/edit#oauth) to enable rendering from a score URL."
    );
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.OSU_CLIENT_ID,
      client_secret: process.env.OSU_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "public",
    }),
  });
  if (!res.ok) {
    throw new Error(`osu! OAuth token request failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

const MODES = ["osu", "taiko", "fruits", "mania"];

/**
 * Accepts an osu! score URL in any of the shapes the website has used:
 *   https://osu.ppy.sh/scores/12345678
 *   https://osu.ppy.sh/scores/osu/12345678
 *   https://osu.ppy.sh/b/123/... (NOT a score url -- rejected)
 * Returns { scoreId } for use with the /scores/{id}/download endpoint.
 */
export function parseScoreUrl(input) {
  const trimmed = String(input).trim();

  // Bare numeric score id -- people often just paste the number.
  if (/^\d+$/.test(trimmed)) {
    return { scoreId: trimmed };
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL or score id: ${input}`);
  }
  if (!/(^|\.)osu\.ppy\.sh$/.test(url.hostname)) {
    throw new Error("Only osu.ppy.sh score URLs are supported.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const scoresIdx = parts.indexOf("scores");
  if (scoresIdx === -1) {
    throw new Error(
      `That's not a score link. Expected osu.ppy.sh/scores/<id> (open the specific play and copy its URL). ` +
        `Beatmap, beatmapset, and profile links don't identify a single score.`
    );
  }
  const rest = parts.slice(scoresIdx + 1);
  let scoreId;
  if (rest.length === 1) {
    scoreId = rest[0];
  } else if (rest.length >= 2 && MODES.includes(rest[0])) {
    scoreId = rest[1];
  } else {
    scoreId = rest[rest.length - 1];
  }
  if (!/^\d+$/.test(scoreId)) {
    throw new Error(`Couldn't extract a numeric score id from ${input}`);
  }
  return { scoreId };
}

/**
 * Downloads the .osr for a given score id via the official API.
 *
 * Caveat: the osu! API only serves a replay when the score has
 * `replay: true` (the player made it downloadable) -- this is NOT
 * guaranteed for arbitrary scores even with a valid app token, and some
 * replay downloads require a user-authorized (not client_credentials)
 * token. If this fails, tell the user to export/upload the .osr directly.
 */
export async function downloadReplayForScore(scoreId) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}/scores/${scoreId}/download`, {
    headers: { Authorization: `Bearer ${token}`, "x-api-version": "20240130" },
  });
  if (res.status === 404) {
    throw new Error(`Score ${scoreId} has no downloadable replay available via the API.`);
  }
  if (!res.ok) {
    throw new Error(`Replay download failed: HTTP ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
