import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import unzipper from "unzipper";
import { dirs } from "../lib/paths.js";

export const skinsRouter = Router();

const upload = multer({ dest: path.join(dirs.uploads, "tmp") });

// We only ship danser-go's own built-in default skin (bundled with the
// binary itself, no folder needed) rather than redistributing third-party
// community skins in the image -- those come from users' own .osk uploads.
skinsRouter.get("/", (req, res) => {
  const uploaded = fs.existsSync(dirs.skins)
    ? fs
        .readdirSync(dirs.skins, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ id: `custom:${e.name}`, name: `${e.name} (uploaded)`, bundled: false }))
    : [];
  res.json([{ id: "bundled:default", name: "danser default", bundled: true }, ...uploaded]);
});

skinsRouter.post("/", upload.single("skin"), async (req, res) => {
  if (!req.file) return res.status(400).send("No skin file uploaded (field name: skin)");
  const originalName = req.file.originalname.replace(/\.osk$/i, "");
  let safeName = originalName.replace(/[^a-zA-Z0-9._ -]/g, "_").trim() || `skin_${Date.now()}`;
  if (safeName.toLowerCase() === "default") safeName += "_uploaded"; // reserved for danser's built-in skin
  const destDir = path.join(dirs.skins, safeName);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    await fs
      .createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: destDir }))
      .promise();
    res.json({ id: `custom:${safeName}`, name: `${safeName} (uploaded)`, bundled: false });
  } catch (err) {
    fs.rmSync(destDir, { recursive: true, force: true });
    res.status(500).send(`Failed to extract skin: ${err.message}`);
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});
