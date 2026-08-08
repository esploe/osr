import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dirs } from "./paths.js";
import { buildJobSettings } from "./danserSettings.js";

const DANSER_BIN = process.env.DANSER_BIN || "/app/danser/danser";
const DANSER_DIR = path.dirname(DANSER_BIN);
const SETTINGS_DIR = path.join(DANSER_DIR, "settings");
const BASE_SETTINGS_NAME = "base";

const FATAL_PATTERNS = [
  /panic:/,
  /Beatmap not found/i,
  /Error connecting to osu!api/i,
  /invalid_client/i,
  /Invalid data found/i,
  /strconv\.ParseFloat/,
];

function runDanser(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    // Whether to force Mesa's software rasterizer is an environment
    // concern, not a danser-invocation concern -- it's controlled by
    // LIBGL_ALWAYS_SOFTWARE/GALLIUM_DRIVER already being set (or not) in
    // process.env by the entrypoint script (docker/entrypoint.sh forces it
    // for the coordinator's software-only container; docker/worker-entrypoint.sh
    // deliberately leaves it unset so Mesa picks the real passed-through
    // GPU driver). Do NOT hardcode/override those two vars here -- this
    // function is shared by both the coordinator and the worker, and doing
    // so previously forced software rendering on the worker too, silently
    // discarding GPU acceleration regardless of what its entrypoint set up.
    //
    // Xvfb itself never does hardware-accelerated GLX (GLFW 3.3, which
    // danser uses, has no EGL-headless option on Linux), so on a real GPU
    // worker we run danser under VirtualGL's EGL back end instead, which
    // intercepts its GLX calls and redirects them straight to the GPU's
    // DRI device. docker/worker-entrypoint.sh sets USE_VIRTUALGL=1; the
    // coordinator's entrypoint never does, so this is a no-op there.
    const useVirtualGL = process.env.USE_VIRTUALGL === "1";
    const command = useVirtualGL ? "vglrun" : DANSER_BIN;
    const commandArgs = useVirtualGL ? ["-d", "egl", DANSER_BIN, ...args] : args;

    const child = spawn(command, commandArgs, { cwd: DANSER_DIR, env: process.env });

    let lastFatalLine = "";
    const handleChunk = (buf) => {
      for (const rawLine of buf.toString("utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (FATAL_PATTERNS.some((re) => re.test(line))) lastFatalLine = line;
        onLine?.(line);
      }
    };
    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.on("error", (err) => reject(new Error(`Failed to launch danser: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(lastFatalLine || `danser exited with code ${code}`));
    });
  });
}

let baseSettingsPromise = null;

/**
 * danser-go generates a complete, version-correct settings file the first
 * time it loads a profile name that doesn't exist yet on disk, and exits
 * cleanly with code 0 (before touching GLFW/OpenGL at all) when it isn't
 * given a beatmap to open. We use that startup behavior to bootstrap a
 * real "base" config once per container lifetime instead of hand-authoring
 * one and risking stale or missing keys as danser evolves.
 */
export function ensureBaseSettings() {
  if (!baseSettingsPromise) {
    baseSettingsPromise = (async () => {
      const basePath = path.join(SETTINGS_DIR, `${BASE_SETTINGS_NAME}.json`);
      if (!fs.existsSync(basePath)) {
        await runDanser([`-settings=${BASE_SETTINGS_NAME}`, "-noupdatecheck"], {
          onLine: (l) => console.log("[danser bootstrap]", l),
        });
      }
      return JSON.parse(fs.readFileSync(basePath, "utf8"));
    })();
  }
  return baseSettingsPromise;
}

/**
 * Renders `replayPath` to a video under dirs.output, named `${job.id}.<container>`.
 * Beatmap resolution is entirely danser's own job: it reads the beatmap MD5
 * out of the replay itself and finds the matching .osu under
 * General.OsuSongsDir (which renderPipeline.js has already populated via
 * the beatmap mirror before calling this).
 */
export async function renderReplayToVideo({ job, replayPath, settings }) {
  const base = await ensureBaseSettings();

  const jobSettings = buildJobSettings(base, {
    songsDir: dirs.songs,
    skinsDir: dirs.skins,
    replaysDir: dirs.uploads,
    outputDir: dirs.output,
    settings,
  });

  const settingsName = `job_${job.id}`;
  const settingsPath = path.join(SETTINGS_DIR, `${settingsName}.json`);
  fs.writeFileSync(settingsPath, JSON.stringify(jobSettings, null, "\t"));

  const args = [
    `-replay=${path.resolve(replayPath)}`,
    `-out=${job.id}`,
    `-settings=${settingsName}`,
    "-noupdatecheck",
    "-nodbcheck",
    "-preciseprogress",
  ];
  if (settings.skipIntro) args.push("-quickstart");

  job.log(`Running danser: ${args.join(" ")}`);

  try {
    await runDanser(args, {
      onLine: (line) => {
        job.log(line);
        const m = line.match(/Progress:\s*(\d+)%/);
        if (m) {
          const pct = Number(m[1]);
          // Beatmap resolution/download already used ~0-25% of the bar;
          // give the actual encode the remaining span.
          job.setStage("rendering", 25 + Math.round((pct / 100) * 70));
        }
      },
    });
  } finally {
    fs.rm(settingsPath, { force: true }, () => {});
  }
}
