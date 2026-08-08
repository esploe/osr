import { Router } from "express";
import express from "express";
import { parseReplayHeader } from "../lib/osrParser.js";

export const replayRouter = Router();

replayRouter.post("/inspect", express.raw({ type: "*/*", limit: "20mb" }), (req, res) => {
  try {
    const meta = parseReplayHeader(req.body);
    res.json(meta);
  } catch (err) {
    res.status(400).send(`Couldn't parse replay: ${err.message}`);
  }
});
