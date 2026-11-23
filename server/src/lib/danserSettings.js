// Maps our UI settings schema onto danser-go's real settings.json shape.
// Field paths here are taken directly from danser-go's app/settings/*.go
// struct definitions (General, Skin, Cursor, Objects, Playfield, Gameplay,
// Recording), not guessed -- see the comments next to anything non-obvious.
//
// We never hand-author a settings.json from scratch: danser itself
// generates a complete, version-correct default file the first time it's
// run (see danser.js#ensureBaseSettings), and we deep-clone + patch that.
// This means fields we don't expose in the UI (Audio, Input, Graphics,
// Debug, Knockout, CursorDance, ...) are left exactly as danser wants them.

export function buildJobSettings(base, { songsDir, skinsDir, replaysDir, outputDir, settings }) {
  const cfg = structuredClone(base);

  cfg.General.OsuSongsDir = songsDir;
  cfg.General.OsuSkinsDir = skinsDir;
  cfg.General.OsuReplaysDir = replaysDir;

  cfg.Skin.CurrentSkin = skinFolderName(settings.skinName);
  cfg.Skin.UseColorsFromSkin = settings.useSkinColors;
  cfg.Skin.UseBeatmapColors = settings.useBeatmapColors;
  cfg.Skin.Cursor.UseSkinCursor = settings.useSkinCursor;
  // "Use skin hitsounds" is really "ignore the beatmap's own custom
  // hitsound samples" from danser's side -- there's no separate Skin.*
  // field for it, it lives under Audio.
  cfg.Audio.IgnoreBeatmapSamples = settings.useSkinHitsounds;

  cfg.Cursor.CursorSize = settings.cursorSize; // osu!px radius, NOT a 0-2 multiplier
  cfg.Cursor.TrailScale = settings.cursorTrail ? 1 : 0; // no dedicated on/off switch in danser
  cfg.Cursor.TrailStyle = settings.trailStyle;
  cfg.Cursor.TrailDensity = settings.trailDensity;
  cfg.Cursor.CursorExpand = settings.cursorExpand;
  cfg.Cursor.CursorRipples = settings.cursorRipples;
  cfg.Cursor.Colors.EnableRainbow = settings.cursorRainbow;

  cfg.Objects.DrawApproachCircles = settings.approachCircles;
  cfg.Objects.DrawFollowPoints = settings.followPoints;
  cfg.Objects.DrawComboNumbers = settings.comboNumbers;
  cfg.Objects.StackEnabled = settings.stackLeniency;
  cfg.Objects.Sliders.Snaking.In = settings.sliderSnakingIn;
  cfg.Objects.Sliders.Snaking.Out = settings.sliderSnakingOut;
  cfg.Objects.Sliders.BorderWidth = settings.sliderBorderWidth;
  cfg.Objects.Sliders.Distortions.Enabled = settings.sliderDistortions;

  cfg.Playfield.Background.Dim.Intro = settings.dimIntro / 100;
  cfg.Playfield.Background.Dim.Normal = settings.dimNormal / 100;
  cfg.Playfield.Background.Dim.Breaks = settings.dimBreaks / 100;
  cfg.Playfield.Background.Blur.Enabled = settings.backgroundBlur;
  cfg.Playfield.Background.Parallax.Enabled = settings.backgroundParallax;
  cfg.Playfield.Background.LoadStoryboards = settings.storyboard;
  cfg.Playfield.Background.LoadVideos = settings.video;
  cfg.Playfield.Background.FlashToTheBeat = settings.flashToBeat;
  cfg.Playfield.LeadInTime = settings.skipIntro ? 0 : settings.leadInTime;
  cfg.Playfield.FadeOutTime = settings.leadOutTime;
  // danser's built-in photosensitivity/epilepsy warning shown before the
  // intro (Playfield.SeizureWarning.Enabled, default true). The nested
  // struct is always present in danser's generated base settings, but guard
  // anyway so an older base.json can't throw here.
  if (cfg.Playfield.SeizureWarning) {
    cfg.Playfield.SeizureWarning.Enabled = settings.seizureWarning;
  }

  cfg.Gameplay.Boundaries.Enabled = settings.playfieldBoundaries;
  cfg.Gameplay.ScoreBoard.Show = settings.scoreboard;
  cfg.Gameplay.ComboCounter.Show = settings.comboCounter;
  cfg.Gameplay.Score.Show = settings.scoreCounter;
  cfg.Gameplay.HpBar.Show = settings.hpBar;
  cfg.Gameplay.KeyOverlay.Show = settings.keyOverlay;
  cfg.Gameplay.PPCounter.Show = settings.ppCounter;
  cfg.Gameplay.HitErrorMeter.Show = settings.hitErrorMeter;
  cfg.Gameplay.HitErrorMeter.ShowUnstableRate = settings.unstableRate;
  cfg.Gameplay.AimErrorMeter.Show = settings.aimErrorMeter;
  cfg.Gameplay.Mods.Show = settings.modsDisplay;
  cfg.Gameplay.ShowHitLighting = settings.hitLighting;

  const [width, height] = String(settings.resolution).split("x").map(Number);
  cfg.Recording.FrameWidth = width;
  cfg.Recording.FrameHeight = height;
  cfg.Recording.FPS = Number(settings.fps);
  cfg.Recording.Encoder = settings.videoCodec;
  cfg.Recording.Container = settings.container;
  cfg.Recording.OutputDir = outputDir;
  cfg.Recording.ShowFFmpegLogs = true;

  if (settings.videoCodec === "h264_vaapi") {
    // danser has no built-in VAAPI preset (Encoder is only a recognized
    // combo value for libx264/libx265/nvenc/qsv/amf) -- any other string
    // falls through to Recording.custom.CustomOptions, which danser
    // appends as raw trailing ffmpeg args after "-c:v h264_vaapi" and the
    // color/pixel-format flags it always adds. Confirmed live (see
    // danser's app/ffmpeg/video.go option ordering) that ffmpeg accepts
    // -vaapi_device in that trailing position, not just up front before -i.
    //
    // PixelFormat=nv12 makes danser do the RGB->NV12 conversion itself on
    // the GPU (app/ffmpeg/video.go's rgbToYuvConverter, a shader-based
    // converter -- see the NV12 branch in MakeFrame()) before reading
    // frames back, instead of piping RGB to ffmpeg and making it do that
    // same conversion again on the CPU via a `format=nv12` filter. That
    // filter was a full-frame CPU conversion pass on every single frame,
    // fighting the entire point of using a hardware encoder -- dropping it
    // and only keeping `hwupload` removes that pass entirely.
    cfg.Recording.PixelFormat = "nv12";
    const vaapiDevice = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
    cfg.Recording.Filters = "hwupload";
    cfg.Recording.custom.CustomOptions = `-vaapi_device ${vaapiDevice} -qp ${Number(settings.crf)}`;
  } else {
    // Recording.<encoder>/<audioCodec> keys are literally named after the
    // combo values (json:"libx264" etc. in recording.go), so we can index
    // straight into cfg.Recording with the selected codec string.
    const videoEnc = cfg.Recording[settings.videoCodec];
    videoEnc.RateControl = "crf";
    videoEnc.CRF = Number(settings.crf);
    videoEnc.Preset = settings.encodePreset;
  }

  // EXPERIMENTAL split-encode (see CLAUDE.md Session 12 for the full
  // diagnosis + measurements, and docker/patches/split-encode.patch for the
  // danser-side implementation): env-gated (SPLIT_ENCODE_EXPERIMENT=1),
  // not yet a real settings-schema option. danser's patched pipeline renders
  // each frame once, then routes contiguous ~5s chunks round-robin between a
  // CPU (libx264, the primary encoder above) and a GPU (VAAPI) ffmpeg process
  // running concurrently, so both mostly-idle-relative-to-each-other hardware
  // resources encode at once. Measured ~17% faster at 1080p60 (74s -> 62s on
  // the RX 570 worker) with objectively transparent quality (SSIM 0.9982 vs
  // a pure-CPU render), at the cost of a ~30% larger file (VAAPI -qp bitrate)
  // and ~2.8GB VRAM of frame buffering. Only usable when the primary encoder
  // is a CPU one (libx264/libx265), matching the case this was validated
  // against; not worth guarding every combination until this either ships for
  // real or gets reverted.
  if (process.env.SPLIT_ENCODE_EXPERIMENT === "1" && settings.videoCodec !== "h264_vaapi") {
    cfg.Recording.PixelFormat = "nv12"; // shared by both encoders, see video.go
    cfg.Recording.SplitEncode = true;
    cfg.Recording.SplitEncoderName = "h264_vaapi";
    const vaapiDevice = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
    cfg.Recording.SplitEncoderCustomOptions = `-vaapi_device ${vaapiDevice} -qp ${Number(settings.crf)}`;
    // h264_vaapi needs frames uploaded to a hardware surface first -- the
    // primary encoder (a CPU one, per the guard above) must NOT get this,
    // so it's set on SplitEncoderFilters, not the shared Recording.Filters.
    cfg.Recording.SplitEncoderFilters = "hwupload";
    // Fraction of chunks kept on the CPU lane. 0.6 (40% to the GPU) was the
    // measured optimum on the RX 570 worker at 1080p60 -- 0.73 (the naive
    // throughput-ratio guess) left the GPU underused; 0.5 started making the
    // GPU the bottleneck. See CLAUDE.md Session 12's ratio sweep.
    cfg.Recording.SplitRatio = Number(process.env.SPLIT_ENCODE_RATIO || "0.6");
  }

  cfg.Recording.AudioCodec = settings.audioCodec;
  const audioEnc = cfg.Recording[settings.audioCodec];
  if (settings.audioCodec === "aac") {
    audioEnc.Bitrate = settings.audioBitrate;
  } else if (settings.audioCodec === "libopus" || settings.audioCodec === "libmp3lame") {
    audioEnc.TargetBitrate = settings.audioBitrate;
  } // flac has no bitrate knob -- CompressionLevel stays at danser's default

  cfg.Recording.MotionBlur.Enabled = settings.motionBlur;
  cfg.Recording.MotionBlur.BlendFrames = Number(settings.motionBlurFrames);

  return cfg;
}

export function skinFolderName(skinId) {
  if (!skinId || skinId === "bundled:default") return "default";
  const [, name] = skinId.split(/:(.+)/);
  return name || "default";
}
