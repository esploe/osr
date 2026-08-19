import { getProfileSettings, submitRender, getJob } from "./renderClient.js";
import { getUserPrefs } from "./prefsStore.js";

const POLL_INTERVAL_MS = Number(process.env.BOT_POLL_INTERVAL_MS || 4000);
const MAX_POLL_MS = 30 * 60 * 1000; // give up rather than poll forever if a job gets stuck

// One render at a time per Discord user, so a burst of pings/mentions
// doesn't queue up duplicate jobs for the same score.
const activeUsers = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRenderSettings(profileSettings, prefs) {
  const merged = { ...(profileSettings || {}) };
  if (prefs.skin) merged.skinName = prefs.skin;
  return Object.keys(merged).length ? merged : null;
}

export async function runRenderFlow(triggerMessage, scoreUrl) {
  const userId = triggerMessage.author.id;
  if (activeUsers.has(userId)) {
    await triggerMessage.reply("You already have a render in progress -- wait for it to finish first.");
    return;
  }
  activeUsers.add(userId);

  let statusMessage;
  try {
    statusMessage = await triggerMessage.reply(`🎬 Queued: ${scoreUrl}`);

    // Precedence for settings sent to the coordinator, lowest to highest:
    // schema defaults (filled in by the coordinator's validateAndMerge if
    // we send null) < BOT_RENDER_PROFILE (shared bot default) < the user's
    // own /settings prefs. The user's skin choice overrides both.
    const profileSettings = await getProfileSettings(process.env.BOT_RENDER_PROFILE);
    const prefs = getUserPrefs(userId);
    const settings = buildRenderSettings(profileSettings, prefs);
    const jobId = await submitRender(scoreUrl, settings);

    let lastStage = null;
    const deadline = Date.now() + MAX_POLL_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const job = await getJob(jobId);

      if (job.status === "done") {
        await statusMessage.edit(
          job.shareUrl
            ? `✅ Done: ${job.shareUrl}`
            : "✅ Render finished, but no Zipline share link is available " +
                "(ZIPLINE_URL/ZIPLINE_TOKEN not configured on the server)."
        );
        return;
      }
      if (job.status === "error") {
        await statusMessage.edit(`❌ Render failed: ${job.error || "unknown error"}`);
        return;
      }
      if (job.stage !== lastStage) {
        lastStage = job.stage;
        await statusMessage.edit(`⏳ ${job.stage}${job.progress ? ` (${job.progress}%)` : ""}`);
      }
    }
    await statusMessage.edit("⌛ Gave up waiting after 30 minutes -- check the web UI for this job's status.");
  } catch (err) {
    const text = `❌ ${err.message}`;
    if (statusMessage) await statusMessage.edit(text).catch(() => {});
    else await triggerMessage.reply(text).catch(() => {});
  } finally {
    activeUsers.delete(userId);
  }
}
