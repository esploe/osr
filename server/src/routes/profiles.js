import { Router } from "express";
import { listProfiles, getProfile, saveProfile, deleteProfile } from "../lib/profiles.js";
import { validateAndMerge } from "../lib/settingsSchema.js";

export const profilesRouter = Router();

profilesRouter.get("/", (req, res) => {
  res.json(listProfiles());
});

profilesRouter.get("/:name", (req, res) => {
  const settings = getProfile(req.params.name);
  if (!settings) return res.status(404).send("Unknown profile.");
  res.json(settings);
});

profilesRouter.post("/", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).send("Profile name is required.");
  if (name.length > 60) return res.status(400).send("Profile name is too long.");
  // Run through the same schema validation as a real render so a saved
  // profile can never contain a bogus/out-of-range value that would only
  // surface as a confusing failure later, at render time.
  const settings = validateAndMerge(req.body?.settings || {});
  saveProfile(name, settings);
  res.json({ ok: true, name });
});

profilesRouter.delete("/:name", (req, res) => {
  const ok = deleteProfile(req.params.name);
  if (!ok) return res.status(404).send("Unknown profile.");
  res.json({ ok: true });
});
