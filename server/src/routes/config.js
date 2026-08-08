import { Router } from "express";
import { GROUPS } from "../lib/settingsSchema.js";
import { isConfigured as osuApiConfigured } from "../lib/osuApi.js";
import { VERSION } from "../lib/version.js";

export const configRouter = Router();

configRouter.get("/", (req, res) => {
  res.json({
    groups: GROUPS,
    scoreUrlEnabled: osuApiConfigured(),
    version: VERSION,
  });
});
