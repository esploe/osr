import { Router } from "express";
import { GROUPS } from "../lib/settingsSchema.js";
import { isConfigured as osuApiConfigured } from "../lib/osuApi.js";

export const configRouter = Router();

configRouter.get("/", (req, res) => {
  res.json({
    groups: GROUPS,
    scoreUrlEnabled: osuApiConfigured(),
  });
});
