// Declarative schema for every user-facing render option. The frontend
// renders its form straight off this (see /api/config), and the backend
// validates submitted values against it before handing them to
// danserSettings.buildJobSettings(). Keeping it data-driven means adding a
// new exposed danser option is a one-entry change here plus one line in
// danserSettings.js, not a form + backend + validation change in three
// places.
//
// Field keys, ranges and defaults are taken directly from danser-go's own
// app/settings/*.go struct definitions (verified against the source, not
// guessed) so the generated settings.json values stay in the ranges danser
// actually accepts.

export const GROUPS = [
  {
    id: "skin",
    label: "Skin",
    fields: [
      {
        key: "skinName",
        label: "Skin",
        type: "select",
        options: [], // populated at runtime from /api/skins
        default: "bundled:default",
        help: "danser's built-in default, or a skin you've uploaded as a .osk file.",
      },
      { key: "useSkinCursor", label: "Use skin cursor", type: "bool", default: false },
      { key: "useSkinColors", label: "Use skin combo colors", type: "bool", default: false },
      { key: "useBeatmapColors", label: "Use beatmap combo colors", type: "bool", default: false },
      { key: "useSkinHitsounds", label: "Use skin hitsounds", type: "bool", default: true, help: "When off, uses the beatmap's own custom hitsound samples instead of the skin's." },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    fields: [
      { key: "cursorSize", label: "Cursor size (osu!px radius)", type: "range", min: 1, max: 50, step: 0.5, default: 12 },
      { key: "cursorTrail", label: "Cursor trail", type: "bool", default: true },
      {
        key: "trailStyle",
        label: "Trail style",
        type: "select",
        options: [
          { value: 1, label: "Unified color" },
          { value: 2, label: "Distance-based rainbow" },
          { value: 3, label: "Time-based rainbow" },
          { value: 4, label: "Gradient" },
        ],
        default: 1,
      },
      { key: "trailDensity", label: "Trail density", type: "range", min: 0.1, max: 3, step: 0.1, default: 1 },
      { key: "cursorRainbow", label: "Rainbow cursor", type: "bool", default: true },
      { key: "cursorRipples", label: "Cursor ripples on click", type: "bool", default: false },
      { key: "cursorExpand", label: "Expand cursor on click", type: "bool", default: false },
    ],
  },
  {
    id: "objects",
    label: "Objects",
    fields: [
      { key: "approachCircles", label: "Approach circles", type: "bool", default: true },
      { key: "followPoints", label: "Follow points", type: "bool", default: true },
      { key: "comboNumbers", label: "Combo numbers", type: "bool", default: true },
      { key: "stackLeniency", label: "Object stacking", type: "bool", default: true },
      { key: "sliderSnakingIn", label: "Slider snaking in", type: "bool", default: true },
      { key: "sliderSnakingOut", label: "Slider snaking out", type: "bool", default: true },
      { key: "sliderBorderWidth", label: "Slider border width", type: "range", min: 0, max: 9, step: 0.5, default: 1 },
      { key: "sliderDistortions", label: "Slider distortion effects", type: "bool", default: true, help: "Turn off to speed up rendering on slower CPUs." },
    ],
  },
  {
    id: "background",
    label: "Background & Playfield",
    fields: [
      { key: "dimIntro", label: "Background dim (intro) %", type: "range", min: 0, max: 100, step: 1, default: 0 },
      { key: "dimNormal", label: "Background dim (gameplay) %", type: "range", min: 0, max: 100, step: 1, default: 95 },
      { key: "dimBreaks", label: "Background dim (breaks) %", type: "range", min: 0, max: 100, step: 1, default: 50 },
      { key: "backgroundBlur", label: "Background blur", type: "bool", default: false },
      { key: "backgroundParallax", label: "Background parallax", type: "bool", default: true },
      { key: "storyboard", label: "Render storyboard", type: "bool", default: true },
      { key: "video", label: "Render background video", type: "bool", default: false },
      { key: "flashToBeat", label: "Flash background to the beat", type: "bool", default: false },
      { key: "playfieldBoundaries", label: "Show playfield boundary", type: "bool", default: true },
    ],
  },
  {
    id: "overlays",
    label: "UI Overlays",
    fields: [
      { key: "scoreboard", label: "Leaderboard / score panel", type: "bool", default: true },
      { key: "comboCounter", label: "Combo counter", type: "bool", default: true },
      { key: "scoreCounter", label: "Score counter", type: "bool", default: true },
      { key: "hpBar", label: "HP bar", type: "bool", default: true },
      { key: "keyOverlay", label: "Key overlay", type: "bool", default: true },
      { key: "ppCounter", label: "PP counter", type: "bool", default: true },
      { key: "hitErrorMeter", label: "Hit error meter", type: "bool", default: true },
      { key: "unstableRate", label: "Unstable rate display", type: "bool", default: true },
      { key: "aimErrorMeter", label: "Aim error meter", type: "bool", default: false },
      { key: "modsDisplay", label: "Mods display", type: "bool", default: true },
      { key: "hitLighting", label: "Hit lighting", type: "bool", default: false },
    ],
  },
  {
    id: "timing",
    label: "Timing",
    fields: [
      { key: "skipIntro", label: "Skip to first object", type: "bool", default: true },
      { key: "leadInTime", label: "Lead-in time (s)", type: "number", min: 0, max: 10, step: 0.5, default: 5, showIf: { skipIntro: false } },
      { key: "leadOutTime", label: "Fade-out time after last object (s)", type: "number", min: 0, max: 10, step: 0.5, default: 5 },
    ],
  },
  {
    id: "output",
    label: "Output",
    fields: [
      {
        key: "resolution",
        label: "Resolution",
        type: "select",
        options: [
          { value: "1280x720", label: "1280x720 (720p)" },
          { value: "1920x1080", label: "1920x1080 (1080p)" },
          { value: "2560x1440", label: "2560x1440 (1440p)" },
          { value: "3840x2160", label: "3840x2160 (4K)" },
        ],
        default: "1920x1080",
        help: "Software rendering scales roughly with pixel count -- 720p renders much faster than 4K on CPU.",
      },
      {
        key: "fps",
        label: "Frame rate",
        type: "select",
        options: [
          { value: 30, label: "30" },
          { value: 60, label: "60" },
          { value: 120, label: "120" },
          { value: 144, label: "144" },
        ],
        default: 60,
      },
      {
        key: "videoCodec",
        label: "Video codec",
        type: "select",
        options: [
          { value: "libx264", label: "H.264 (libx264, software) -- best compatibility" },
          { value: "libx265", label: "H.265 (libx265, software) -- smaller files, slower encode" },
          { value: "h264_vaapi", label: "H.264 hardware (VAAPI) -- needs a GPU render worker with VAAPI set up" },
        ],
        default: "libx264",
        help: "VAAPI offloads encoding to the render worker's GPU instead of its CPU -- only works when that job actually renders on a worker with a compatible GPU (AMD/Intel via Mesa VAAPI); falls back to erroring out on CPU-only renders.",
      },
      {
        key: "encodePreset",
        label: "Encoder speed preset",
        type: "select",
        options: [
          "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo",
        ].map((v) => ({ value: v, label: v })),
        default: "faster",
        help: "Software encoders only (libx264/libx265) -- ignored for VAAPI.",
        showIf: { videoCodec: ["libx264", "libx265"] },
      },
      { key: "crf", label: "Quality (CRF/QP, lower = better)", type: "range", min: 0, max: 51, step: 1, default: 16 },
      {
        key: "container",
        label: "Container",
        type: "select",
        options: [
          { value: "mp4", label: "MP4" },
          { value: "mkv", label: "MKV" },
        ],
        default: "mp4",
      },
      {
        key: "audioCodec",
        label: "Audio codec",
        type: "select",
        options: [
          { value: "aac", label: "AAC" },
          { value: "libopus", label: "Opus" },
          { value: "libmp3lame", label: "MP3" },
          { value: "flac", label: "FLAC (lossless)" },
        ],
        default: "aac",
      },
      {
        key: "audioBitrate",
        label: "Audio bitrate",
        type: "select",
        options: [
          { value: "128k", label: "128 kbps" },
          { value: "192k", label: "192 kbps" },
          { value: "320k", label: "320 kbps" },
        ],
        default: "192k",
        showIf: { audioCodec: "aac" },
        help: "Not used for FLAC (always lossless).",
      },
      { key: "motionBlur", label: "Motion blur (frame blending)", type: "bool", default: false },
      { key: "motionBlurFrames", label: "Motion blur blend frames", type: "number", min: 2, max: 64, step: 1, default: 24, showIf: { motionBlur: true } },
    ],
  },
];

export function defaultsFromSchema() {
  const defaults = {};
  for (const group of GROUPS) {
    for (const field of group.fields) {
      defaults[field.key] = field.default;
    }
  }
  return defaults;
}

export function validateAndMerge(userValues = {}) {
  const merged = defaultsFromSchema();
  for (const group of GROUPS) {
    for (const field of group.fields) {
      if (!(field.key in userValues)) continue;
      const raw = userValues[field.key];
      merged[field.key] = coerce(field, raw);
    }
  }
  return merged;
}

function coerce(field, raw) {
  switch (field.type) {
    case "bool":
      return raw === true || raw === "true" || raw === "on" || raw === 1;
    case "number":
    case "range": {
      const n = Number(raw);
      if (Number.isNaN(n)) return field.default;
      if (field.min !== undefined && n < field.min) return field.min;
      if (field.max !== undefined && n > field.max) return field.max;
      return n;
    }
    case "select": {
      // skinName's real option list is only known at runtime (populated
      // client-side from /api/skins, see index.html/app.js) -- the schema
      // itself always carries options: [] for it. Validating against that
      // empty array would reject every real selection and silently reset
      // to the default, which is exactly the "skin picker doesn't do
      // anything" bug this fixes: an empty static option list means "not
      // statically validatable", not "nothing is allowed".
      if (field.options.length === 0) {
        return typeof raw === "string" && raw.trim() ? raw.trim() : field.default;
      }
      const allowed = field.options.map((o) => o.value);
      // numeric-valued selects arrive as strings from form fields
      const asNumber = Number(raw);
      if (allowed.includes(raw)) return raw;
      if (allowed.includes(asNumber)) return asNumber;
      return field.default;
    }
    default:
      return raw;
  }
}
