// Small, bot-scoped osu! API v2 client. Deliberately not shared with
// server/src/lib/osuApi.js -- the bot runs as its own container/image and
// never downloads replay bytes itself (the coordinator does that from a
// scoreUrl via its own copy of this OAuth dance), it only needs read-only
// score/user lookups to figure out *which* score to hand the coordinator.
const TOKEN_URL = "https://osu.ppy.sh/oauth/token";
const API_BASE = "https://osu.ppy.sh/api/v2";

let cachedToken = null; // { token, expiresAt }

function requireCredentials() {
  if (!process.env.OSU_CLIENT_ID || !process.env.OSU_CLIENT_SECRET) {
    throw new Error(
      "OSU_CLIENT_ID/OSU_CLIENT_SECRET are not set -- the Discord bot needs osu! API " +
        "credentials to look up scores (same ones the coordinator's score-URL rendering uses)."
    );
  }
}

async function getToken() {
  requireCredentials();
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

async function apiGet(pathAndQuery) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}`, "x-api-version": "20240130" },
  });
  if (!res.ok) {
    throw new Error(`osu! API request failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function modsToString(mods) {
  return (mods || []).map((m) => (typeof m === "string" ? m : m.acronym)).join("").toUpperCase();
}

function scoreToUrl(score) {
  // Matches the shape server/src/lib/osuApi.js#parseScoreUrl expects.
  return `https://osu.ppy.sh/scores/${score.id}`;
}

export async function getUser(username) {
  try {
    return await apiGet(`/users/${encodeURIComponent(username)}?key=username`);
  } catch {
    return null;
  }
}

// `key=username` only works on the /users/{user} top-level lookup; the
// /users/{user}/scores/* and /beatmaps/{b}/scores/users/{user}/all
// subresource paths require a numeric user ID and 404 with a bare username
// (this was live-observed as an unhelpful "HTTP 404 {"error":null}" from
// getUserRecentScoreUrl). Resolve to an id once and reuse it downstream.
async function resolveUserId(username) {
  const user = await apiGet(`/users/${encodeURIComponent(username)}?key=username`);
  if (!user?.id) throw new Error(`No osu! user named "${username}".`);
  return user.id;
}

// Every lookup here is pinned to mode=osu: the render pipeline rejects any
// replay whose header isn't osu!standard (renderPipeline.js), so a hit in
// another mode would just fail downstream anyway -- no point surfacing it.
export async function getUserRecentScoreUrl(username) {
  const userId = await resolveUserId(username);
  const scores = await apiGet(`/users/${userId}/scores/recent?mode=osu&include_fails=1&limit=1`);
  if (!scores.length) {
    throw new Error(`No recent osu!standard scores found for "${username}".`);
  }
  return scoreToUrl(scores[0]);
}

export async function getUserScoreOnBeatmapUrl(username, beatmapId, mods) {
  const userId = await resolveUserId(username);
  const data = await apiGet(`/beatmaps/${beatmapId}/scores/users/${userId}/all?mode=osu`);
  const scores = data.scores || [];
  if (!scores.length) {
    throw new Error(`Couldn't find an osu!standard score by "${username}" on that beatmap.`);
  }
  if (mods) {
    const wanted = mods.toUpperCase();
    const match = scores.find((s) => modsToString(s.mods) === wanted);
    if (match) return scoreToUrl(match);
  }
  const mostRecent = scores.reduce((a, b) => (new Date(b.ended_at) > new Date(a.ended_at) ? b : a));
  return scoreToUrl(mostRecent);
}
