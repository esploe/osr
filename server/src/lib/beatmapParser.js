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
      const endTime = computeSliderEndTime({
        startTime: time,
        pixelLength,
        repeats,
        sliderMultiplier,
        timingPoints,
      });
      return { ...base, kind: "slider", repeats, pixelLength, endTime };
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
