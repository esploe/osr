import dns from "node:dns";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node's built-in fetch (used by ziplineClient.js) handles dual-stack
// DNS results much less gracefully than curl's Happy-Eyeballs fallback --
// on a network that resolves AAAA records for a host but has no actual
// IPv6 route, fetch() can fail outright instead of falling back to the
// working IPv4 address the way curl does. Forcing IPv4-first here sidesteps
// that gap entirely rather than depending on undici's fallback behavior.
dns.setDefaultResultOrder("ipv4first");
import { renderRouter } from "./routes/render.js";
import { skinsRouter } from "./routes/skins.js";
import { configRouter } from "./routes/config.js";
import { replayRouter } from "./routes/replay.js";
import { internalRouter } from "./routes/internal.js";
import { profilesRouter } from "./routes/profiles.js";
import { missAnalyzerRouter } from "./routes/missAnalyzer.js";
import { ensureBaseSettings } from "./lib/danser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = process.env.WEB_DIR || path.join(__dirname, "..", "..", "web");

// Kick off danser's settings bootstrap immediately so a broken build fails
// loudly in container startup logs instead of on someone's first render.
ensureBaseSettings().catch((err) => {
  console.error("Failed to bootstrap danser settings:", err.message);
});

const app = express();
app.use(express.json());

app.use("/api/render", renderRouter);
app.use("/api/skins", skinsRouter);
app.use("/api/config", configRouter);
app.use("/api/replay", replayRouter);
app.use("/api/internal", internalRouter);
app.use("/api/profiles", profilesRouter);
app.use("/api/miss-analyzer", missAnalyzerRouter);

app.use(express.static(webDir));

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`osu-replay-renderer listening on :${port}`);
});
