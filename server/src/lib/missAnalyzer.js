// Detects missed hit objects by replaying the cursor stream against the
// beatmap's hit-object timeline.
//
// Scope, called out on purpose:
//  * osu!standard only (mode 0). Danser only supports std anyway.
//  * Sliders are judged as their head-position circle -- the head is what
//    almost every real miss actually is; slider-body-only "misses" (drop
//    ticks / lose end judgment) are not counted here.
//  * Spinners are skipped -- judging one needs the full spin-rate model.
//  * Notelock (older ranking algorithm) isn't modeled; we just take the
//    earliest key-press-inside-the-radius within the object's 50-window.
//    That can flag a rare object as "hit" that osu! would have missed
//    due to a still-active earlier note, but it's a good baseline.

import { HIT_KEYS_MASK } from "./osrParser.js";

// osu! mod bits we care about here -- copied to avoid a cross-file import cycle.
const MOD_EZ = 1 << 1;
const MOD_HR = 1 << 4;

// hit-window (ms) for the "50" judgment on osu!std: |cursor_press_time - object_time|
// larger than this and no press-inside-radius means the object misses.
function hitWindow50(od) {
  return 200 - 10 * od;
}

// Circle radius in osu! pixels (playfield is 512x384). Formula from osu!std
// difficulty spec: r = 54.4 - 4.48 * CS (approx, with CS in [0, 10]).
function circleRadius(cs) {
  return 54.4 - 4.48 * cs;
}

// osu!std approach-rate preempt time (ms) -- how long an object stays
// visible before its hit time. Match to the wider of the two windows
// used for the context view; we want the reader to see everything that
// was already on screen when the miss happened, not just objects with
// exact hit-times inside our slice.
function preemptMs(ar) {
  if (ar < 5) return 1200 + 600 * (5 - ar) / 5;
  if (ar > 5) return 1200 - 750 * (ar - 5) / 5;
  return 1200;
}

// How long around the miss to include context in the response so the UI
// can render nearby objects + cursor path + play back the moment. Wider
// than a still-image needs (~1.5s) because the UI now supports a
// scrub/play interaction where the reader wants a real "few seconds
// before and after" window to explore.
const CONTEXT_BEFORE_MS = 3000;
const CONTEXT_AFTER_MS = 1500;

function applyMods(diff, mods) {
  let { OD, CS, AR } = diff;
  if (mods & MOD_HR) {
    OD = Math.min(10, OD * 1.4);
    CS = Math.min(10, CS * 1.3);
    AR = Math.min(10, AR * 1.4);
  } else if (mods & MOD_EZ) {
    OD = OD / 2;
    CS = CS / 2;
    AR = AR / 2;
  }
  return { OD, CS, AR };
}

export function analyzeMisses({ frames, beatmap, mods = 0 }) {
  if (beatmap.mode !== 0) {
    return { misses: [], warning: `Miss analyzer only supports osu!standard (mode 0); this map is mode ${beatmap.mode}.` };
  }
  const { OD, CS, AR } = applyMods(beatmap.difficulty, mods);
  const hw50 = hitWindow50(OD);
  const radius = circleRadius(CS);
  const preempt = preemptMs(AR);

  const misses = [];
  let frameIdx = 0; // walking pointer -- frames are time-sorted, so we only ever move forward
  let prevKeys = 0;

  // Objects are time-sorted in the .osu file (osu enforces this). We walk
  // both cursors together: for each object, look at every frame whose
  // time is inside the object's judgment window.
  for (const obj of beatmap.hitObjects) {
    if (obj.kind === "spinner") continue;

    const windowStart = obj.time - hw50;
    const windowEnd = obj.time + hw50;

    // Skip any frames strictly before this object's window -- but track key
    // state so that a key that was already held down when the window opens
    // doesn't count as a fresh press inside it (osu requires a rising edge).
    while (frameIdx < frames.length && frames[frameIdx].t < windowStart) {
      prevKeys = frames[frameIdx].k;
      frameIdx++;
    }

    let hit = false;
    let closest = null; // best-effort "how close did they come" for the UI
    let scan = frameIdx;
    let scanPrev = prevKeys;

    while (scan < frames.length && frames[scan].t <= windowEnd) {
      const f = frames[scan];
      const dx = f.x - obj.x;
      const dy = f.y - obj.y;
      const dist = Math.hypot(dx, dy);
      if (closest === null || dist < closest.dist) {
        closest = { dist, x: f.x, y: f.y, t: f.t };
      }
      const pressedNow = f.k & HIT_KEYS_MASK & ~scanPrev; // rising edge only
      if (pressedNow && dist <= radius) {
        hit = true;
        break;
      }
      scanPrev = f.k;
      scan++;
    }

    if (!hit) {
      // Fallback for a "closest frame" when nothing landed inside the
      // whole judgment window either: use the frame nearest in time to
      // the object, so the UI has *something* to draw.
      if (!closest) {
        const nearest = findNearestByTime(frames, obj.time);
        if (nearest) {
          closest = {
            dist: Math.hypot(nearest.x - obj.x, nearest.y - obj.y),
            x: nearest.x,
            y: nearest.y,
            t: nearest.t,
          };
        }
      }
      const taps = collectTapsAround({ obj, frames, radius });
      misses.push({
        objectIndex: obj.index,
        kind: obj.kind,
        objectTime: obj.time,
        objectX: obj.x,
        objectY: obj.y,
        cursor: closest,
        taps,
        diagnosis: diagnoseMiss({ obj, taps, hw50, radius, closest }),
        context: buildContext({ obj, beatmap, frames }),
      });
    }
  }

  return {
    misses,
    stats: {
      totalObjects: beatmap.hitObjects.length,
      judgedObjects: beatmap.hitObjects.filter((o) => o.kind !== "spinner").length,
      spinnersSkipped: beatmap.hitObjects.filter((o) => o.kind === "spinner").length,
      hitWindow50Ms: hw50,
      circleRadiusOsuPx: radius,
      effectiveOD: OD,
      effectiveCS: CS,
      effectiveAR: AR,
      preemptMs: preempt,
    },
  };
}

// Slice of context around a single miss -- everything the UI needs to
// draw a "moment in time" view: hit objects that were visible on
// screen near the miss (fading-in approach circles + already-past
// objects), and the cursor's path across the same window.
function buildContext({ obj, beatmap, frames }) {
  const tMin = obj.time - CONTEXT_BEFORE_MS;
  const tMax = obj.time + CONTEXT_AFTER_MS;

  const objects = [];
  for (const other of beatmap.hitObjects) {
    // A slider is visible if its head is in-range OR if its body is
    // still on screen at any point in the window.
    const endT = other.kind === "slider" ? other.endTime : other.time;
    if (other.time > tMax) break; // hitObjects are time-sorted
    if (endT < tMin) continue;
    objects.push(compactObject(other));
  }

  // Cursor polyline for the same window. Keep `k` (keys bitfield) so the
  // client can visualize when hit-keys are held during playback -- this
  // is the missing signal that makes "no-tap" misses vs "aim-off" misses
  // legible without having to squint at the diagnosis text.
  const cursor = [];
  for (const f of frames) {
    if (f.t < tMin) continue;
    if (f.t > tMax) break;
    cursor.push([Math.round(f.t), Math.round(f.x * 10) / 10, Math.round(f.y * 10) / 10, f.k]);
  }

  return { objects, cursor, windowStart: tMin, windowEnd: tMax };
}

// Every rising-edge hit-key press in a wide window around the object,
// with its cursor position captured so we can measure "how far off"
// each attempt was. Wider window than the 50 hit window on purpose: an
// obvious early tap (say 180ms early) should still surface as "you
// tapped, just too early", not as "no tap at all".
const TAP_LOOKAROUND_MS = 400;
function collectTapsAround({ obj, frames, radius }) {
  const from = obj.time - TAP_LOOKAROUND_MS;
  const to = obj.time + TAP_LOOKAROUND_MS;
  const taps = [];
  let prevKeys = 0;
  for (const f of frames) {
    if (f.t < from) { prevKeys = f.k; continue; }
    if (f.t > to) break;
    const pressed = f.k & HIT_KEYS_MASK & ~prevKeys;
    if (pressed) {
      const dist = Math.hypot(f.x - obj.x, f.y - obj.y);
      taps.push({
        t: Math.round(f.t),
        dOffset: Math.round(f.t - obj.time),
        keys: pressed,
        x: Math.round(f.x * 10) / 10,
        y: Math.round(f.y * 10) / 10,
        dist: Math.round(dist * 10) / 10,
        inRadius: dist <= radius,
      });
    }
    prevKeys = f.k;
  }
  return taps;
}

// Plain-English "what went wrong" line for a single miss, built from the
// taps that landed near it. The whole point of the miss analyzer is to
// answer this question in one glance -- the playback + timeline visuals
// let the reader *verify* the diagnosis, but the sentence itself should
// already tell them.
function diagnoseMiss({ obj, taps, hw50, radius, closest }) {
  if (!taps.length) {
    return {
      category: "no_tap",
      text: `No tap at all within ${TAP_LOOKAROUND_MS}ms of this note.` +
        (closest ? ` Closest the cursor came to the note was ${Math.round(closest.dist)}px, at ${msDelta(closest.t - obj.time)}.` : ""),
    };
  }
  const inTime = taps.filter((t) => Math.abs(t.dOffset) <= hw50);
  const inAimTaps = taps.filter((t) => t.inRadius);
  const inBoth = taps.find((t) => Math.abs(t.dOffset) <= hw50 && t.inRadius);
  if (inBoth) {
    // Shouldn't happen -- the analyzer would have marked this a hit --
    // but keep a safe fallback so we never silently misreport.
    return { category: "unknown", text: "Analyzer detected a tap inside the hit-window AND inside the radius, but marked the object missed. This is likely a notelock case (a previous slider was still active); the game refused to award the hit." };
  }
  if (inTime.length) {
    // Tapped in time, but every tap was off-target.
    const best = inTime.reduce((a, b) => (a.dist < b.dist ? a : b));
    return {
      category: "aim_miss",
      text: `Tapped in time (${msDelta(best.dOffset)}) but aimed ${Math.round(best.dist)}px off — radius is ${Math.round(radius)}px.`,
    };
  }
  if (inAimTaps.length) {
    // Aimed onto the note, but every tap was too early or too late.
    const best = inAimTaps.reduce((a, b) => (Math.abs(a.dOffset) < Math.abs(b.dOffset) ? a : b));
    return {
      category: best.dOffset < 0 ? "early_tap" : "late_tap",
      text: `Cursor was on the note but tapped ${msDelta(best.dOffset)} — 50-window is only ±${Math.round(hw50)}ms.`,
    };
  }
  // Nothing in time, nothing in radius -- pick the tap that came
  // closest overall (weighted equally-ish) and describe both errors.
  const best = taps.reduce((a, b) => (score(a) < score(b) ? a : b));
  return {
    category: "both_off",
    text: `Closest tap was ${msDelta(best.dOffset)} and ${Math.round(best.dist)}px off — needed ±${Math.round(hw50)}ms and ≤${Math.round(radius)}px.`,
  };
}

function score(t) {
  return Math.abs(t.dOffset) + t.dist * 2; // px matter roughly 2x as much as ms here; heuristic
}

function msDelta(ms) {
  const sign = ms >= 0 ? "+" : "";
  return `${sign}${Math.round(ms)}ms`;
}

function compactObject(o) {
  const base = { i: o.index, k: o.kind[0], t: o.time, x: o.x, y: o.y };
  if (o.kind === "slider") {
    return {
      ...base,
      et: o.endTime,
      // Downsample the curve polyline to keep JSON small -- 32 points
      // is plenty for a slider body outline at UI zoom.
      cp: downsample(o.curve?.points || [], 32).map((p) => [Math.round(p.x), Math.round(p.y)]),
    };
  }
  if (o.kind === "spinner") return { ...base, et: o.endTime };
  return base;
}

function downsample(points, maxN) {
  if (points.length <= maxN) return points;
  const step = (points.length - 1) / (maxN - 1);
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function findNearestByTime(frames, t) {
  if (!frames.length) return null;
  // Binary search for the frame whose time is closest to t.
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const cand = [frames[lo]];
  if (lo > 0) cand.push(frames[lo - 1]);
  cand.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
  return cand[0];
}
