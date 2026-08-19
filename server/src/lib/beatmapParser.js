// Minimal osu! beatmap (.osu, v14) parser -- extracts just what the
// miss analyzer needs: mode, difficulty settings, and hit objects
// (time, position, type). Sliders keep their raw curve string but we
// treat them as their head-position circle for miss judgment; that's
// almost always right (missing a slider = missing its head) and
// avoids implementing the full bezier/catmull slider path evaluator.

// Hit-object type bitfield (bits 0/1/3 are what we care about):
export const HO_CIRCLE = 1 << 0;
export const HO_SLIDER = 1 << 1;
export const HO_SPINNER = 1 << 3;

export function parseBeatmap(text) {
  const lines = text.split(/\r?\n/);
  const sections = {};
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }

  const kv = (sectionName) => {
    const out = {};
    for (const line of sections[sectionName] || []) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
  };

  const general = kv("General");
  const difficulty = kv("Difficulty");
  const metadata = kv("Metadata");

  const timingPoints = (sections.TimingPoints || []).map((line) => {
    const p = line.split(",");
    // v14 TimingPoint format: time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
    return {
      time: Number(p[0]),
      beatLength: Number(p[1]),
      meter: Number(p[2] ?? 4),
      uninherited: p[6] !== undefined ? p[6] === "1" : true,
    };
  });

  const sliderMultiplier = Number(difficulty.SliderMultiplier ?? 1.4);
  const sliderTickRate = Number(difficulty.SliderTickRate ?? 1);

  const hitObjects = (sections.HitObjects || []).map((line, i) => {
    const p = line.split(",");
    const x = Number(p[0]);
    const y = Number(p[1]);
    const time = Number(p[2]);
    const type = Number(p[3]);
    const base = { index: i, x, y, time, type };
    if (type & HO_SPINNER) {
      return { ...base, kind: "spinner", endTime: Number(p[5]) };
    }
    if (type & HO_SLIDER) {
      // p[5] = curveType|point|point|... , p[6] = repeats, p[7] = pixelLength
      const repeats = Number(p[6] ?? 1);
      const pixelLength = Number(p[7] ?? 0);
      const curve = parseSliderCurve(p[5] || "", { headX: x, headY: y });
      const endTime = computeSliderEndTime({
        startTime: time,
        pixelLength,
        repeats,
        sliderMultiplier,
        timingPoints,
      });
      return { ...base, kind: "slider", repeats, pixelLength, endTime, curve };
    }
    return { ...base, kind: "circle" };
  });

  return {
    mode: Number(general.Mode ?? 0),
    title: metadata.Title || "",
    artist: metadata.Artist || "",
    version: metadata.Version || "",
    difficulty: {
      HP: Number(difficulty.HPDrainRate ?? 5),
      CS: Number(difficulty.CircleSize ?? 5),
      OD: Number(difficulty.OverallDifficulty ?? 5),
      AR: Number(difficulty.ApproachRate ?? difficulty.OverallDifficulty ?? 5),
      sliderMultiplier,
      sliderTickRate,
    },
    timingPoints,
    hitObjects,
  };
}

// Parse the slider curve spec ("B|x:y|x:y|...", "L|...", "P|...", "C|...")
// into a sampled polyline in playfield coordinates. We don't need pixel-
// perfect path lengths (osu! itself only uses the curve for visuals and
// slider-tick spacing, which the miss analyzer doesn't judge) -- a
// coarse polyline is enough to draw a recognizable body shape.
function parseSliderCurve(spec, { headX, headY }) {
  const parts = spec.split("|");
  if (parts.length < 2) return { kind: "linear", points: [{ x: headX, y: headY }] };
  const kind = parts[0]; // B=bezier, L=linear, P=perfect-circle, C=catmull
  const controls = [{ x: headX, y: headY }];
  for (let i = 1; i < parts.length; i++) {
    const [cx, cy] = parts[i].split(":").map(Number);
    if (Number.isFinite(cx) && Number.isFinite(cy)) controls.push({ x: cx, y: cy });
  }
  if (controls.length < 2) return { kind: "linear", points: controls };
  if (kind === "L") return { kind: "linear", points: controls };
  if (kind === "P" && controls.length === 3) return { kind: "perfect", points: samplePerfectCircle(controls, 32) };
  // Bezier and Catmull: split at repeated control points into sub-segments,
  // then sample each with a small number of steps and concatenate. Curve
  // types we don't specially handle (Catmull is rare) fall through to a
  // straight polyline, which is a reasonable "we can't render this
  // accurately, at least give a general direction" fallback.
  const segments = splitAtDuplicates(controls);
  const pts = [{ x: controls[0].x, y: controls[0].y }];
  for (const seg of segments) {
    for (let step = 1; step <= 20; step++) {
      const t = step / 20;
      const p = kind === "B" ? bezierEval(seg, t) : linearEval(seg, t);
      pts.push(p);
    }
  }
  return { kind: kind === "B" ? "bezier" : "linear", points: pts };
}

function splitAtDuplicates(pts) {
  const out = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x === pts[i - 1].x && pts[i].y === pts[i - 1].y) {
      out.push(pts.slice(start, i));
      start = i;
    }
  }
  out.push(pts.slice(start));
  return out.filter((s) => s.length >= 2);
}

function bezierEval(controls, t) {
  const pts = controls.map((p) => ({ x: p.x, y: p.y }));
  for (let i = pts.length - 1; i > 0; i--) {
    for (let j = 0; j < i; j++) {
      pts[j].x = pts[j].x * (1 - t) + pts[j + 1].x * t;
      pts[j].y = pts[j].y * (1 - t) + pts[j + 1].y * t;
    }
  }
  return pts[0];
}

function linearEval(controls, t) {
  const a = controls[0];
  const b = controls[controls.length - 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Perfect-circle sliders use exactly 3 control points; the arc is the
// unique circle through those three. If they're collinear, degrade
// gracefully to a straight line so we still draw *something*.
function samplePerfectCircle([p1, p2, p3], steps) {
  const ax = p2.x - p1.x, ay = p2.y - p1.y;
  const bx = p3.x - p1.x, by = p3.y - p1.y;
  const d = 2 * (ax * by - ay * bx);
  if (Math.abs(d) < 1e-6) return [p1, p3];
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const cx = p1.x + (by * a2 - ay * b2) / d;
  const cy = p1.y + (ax * b2 - bx * a2) / d;
  const r = Math.hypot(p1.x - cx, p1.y - cy);
  const a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const a3 = Math.atan2(p3.y - cy, p3.x - cx);
  // Direction (CW vs CCW) is decided by whether p2 sits on the short arc.
  const midAngle = Math.atan2(p2.y - cy, p2.x - cx);
  let start = a1, end = a3;
  const short = ((end - start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const relMid = ((midAngle - start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (relMid > short) end = start + short - 2 * Math.PI;
  else end = start + short;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + (end - start) * (i / steps);
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

// Slider duration in ms = pixelLength / (100 * sliderMultiplier * SV) * beatLength * repeats,
// where SV is the inherited timing-point multiplier (1 if no inherited point applies).
// See osu! wiki "Beatmap > Slider" / "Timing point > Inherited timing points".
function computeSliderEndTime({ startTime, pixelLength, repeats, sliderMultiplier, timingPoints }) {
  let uninheritedBeatLength = 500;
  let sv = 1;
  for (const tp of timingPoints) {
    if (tp.time > startTime) break;
    if (tp.uninherited) {
      uninheritedBeatLength = tp.beatLength;
      sv = 1;
    } else if (tp.beatLength < 0) {
      // Inherited: beatLength is a negative percentage; SV = -100 / beatLength.
      sv = -100 / tp.beatLength;
    }
  }
  const oneSpanMs = (pixelLength / (100 * sliderMultiplier * sv)) * uninheritedBeatLength;
  return startTime + oneSpanMs * Math.max(1, repeats);
}
