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

function applyMods(diff, mods) {
  let { OD, CS } = diff;
  if (mods & MOD_HR) {
    OD = Math.min(10, OD * 1.4);
    CS = Math.min(10, CS * 1.3);
  } else if (mods & MOD_EZ) {
    OD = OD / 2;
    CS = CS / 2;
  }
  return { OD, CS };
}

export function analyzeMisses({ frames, beatmap, mods = 0 }) {
  if (beatmap.mode !== 0) {
    return { misses: [], warning: `Miss analyzer only supports osu!standard (mode 0); this map is mode ${beatmap.mode}.` };
  }
  const { OD, CS } = applyMods(beatmap.difficulty, mods);
  const hw50 = hitWindow50(OD);
  const radius = circleRadius(CS);

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
      misses.push({
        objectIndex: obj.index,
        kind: obj.kind,
        objectTime: obj.time,
        objectX: obj.x,
        objectY: obj.y,
        cursor: closest,
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
    },
  };
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
