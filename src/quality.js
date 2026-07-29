// How many sprites the machine gets to animate.
//
// The transition is the only genuinely expensive thing on the site: ten
// thousand canvas sprites, each posed and blitted every frame. That is fine on
// a laptop and miserable on a four-year-old phone, so the budget is chosen per
// machine rather than fixed.
//
// Three signals decide it, and they are used in that order because they have
// very different reliability:
//
//   1. **Touch-first compact viewport**, before anything has been drawn. A
//      coarse primary pointer, real touch points and a short viewport side
//      identify phones and tablets without mistaking a narrow laptop window
//      or a touch-capable laptop using its trackpad for a mobile device.
//   2. **Declared capability**, before anything has been drawn. Cheap, but a
//      guess: `deviceMemory` is Chromium-only and buckets coarsely, and core
//      count says nothing about the GPU.
//   3. **Observed frame cost**, measured during the first transition that
//      actually runs. This is the honest signal, and it is why the tier can
//      still drop after the fact — a machine that says it is capable and then
//      cannot hold a frame rate gets demoted for every subsequent transition.
//
// The budget is spent through `limitTransitionFragments`, which samples every
// role and piece-position stratum evenly, so a mobile or lite page is the same
// picture drawn with fewer pieces rather than a cropped or lopsided one.

export const FULL_TOKEN_LIMIT = 10000;
export const LITE_TOKEN_LIMIT = 1600;
export const MOBILE_TOKEN_MULTIPLIER = 3;
export const MOBILE_MIN_TOKEN_LIMIT = 1440;
export const MOBILE_MAX_TOKEN_LIMIT = 2160;
export const MOBILE_PIXELS_PER_TOKEN = 560;

export const FULL_GLOBAL_DPR_CAP = 1.3;
export const FULL_LOCAL_DPR_CAP = 1.55;
export const MOBILE_GLOBAL_DPR_CAP = 1;
export const MOBILE_LOCAL_DPR_CAP = 1;

const MOBILE_SHORT_SIDE_MAX = 900;

// Rendering work that is independent of the global sprite count. The full
// profile is deliberately a transcription of the established constants in
// motion.js, photo.js and aging.js: consumers can switch to these options
// without changing a desktop or laptop by a single frame or admission.
const FULL_PERFORMANCE_PROFILE = Object.freeze({
  localFrameMs: 14,
  pointerFrameMs: 14,
  midpointActiveFrameMs: 14,
  midpointIdleFrameMs: 30,
  transitionFrameMs: 0,
  pointerSamples: 20,
  rotatingTokenStride: 1,
  passiveMidpointMotion: true,
  localEffectSoftLimit: 28,
  localEffectHardLimit: 40,
  localRetiredEffectLimit: 56,
  maxVisualGlyphs: 9,
  maxNewVisualsPerFrame: 2,
  midpointEffectSoftLimit: 112,
  midpointEffectHardLimit: 160,
  midpointRetiredEffectLimit: 288,
  midpointVisualBurst: 72,
  maxNewMidpointVisualsPerFrame: 12,
  imageTileTarget: 260,
  photo: Object.freeze({
    dprCap: 2,
    maxPaintsPerTick: 26,
    churnPerTick: 10,
    cacheCleanBlocks: false,
  }),
  aging: Object.freeze({
    tickMs: 380,
    maxWritesPerTick: 90,
    noiseTickMs: 110,
    noisePerTick: 30,
    liveLimit: 96,
    liveRotateMs: 700,
  }),
});

// Phones keep the same thirty-ish canvas cadence as desktop motion, but spend
// less work inside each frame. A smaller, area-scaled field and sparse token
// rotation preserve the silhouette and orbital motion while avoiding the
// expensive transformed-draw path for most pieces. At rest, the assembled
// dragon holds still until it is touched, so an idle midpoint costs no frames.
const MOBILE_PERFORMANCE_PROFILE = Object.freeze({
  localFrameMs: 32,
  pointerFrameMs: 32,
  midpointActiveFrameMs: 32,
  midpointIdleFrameMs: 50,
  transitionFrameMs: 32,
  pointerSamples: 6,
  rotatingTokenStride: 4,
  passiveMidpointMotion: false,
  localEffectSoftLimit: 12,
  localEffectHardLimit: 18,
  localRetiredEffectLimit: 24,
  maxVisualGlyphs: 6,
  maxNewVisualsPerFrame: 1,
  midpointEffectSoftLimit: 48,
  midpointEffectHardLimit: 72,
  midpointRetiredEffectLimit: 96,
  midpointVisualBurst: 32,
  maxNewMidpointVisualsPerFrame: 6,
  imageTileTarget: 96,
  photo: Object.freeze({
    // The full-screen motion canvases stay at 1×, but the photographs are
    // presentation content and must remain sharp on retina phone displays.
    dprCap: 3,
    maxPaintsPerTick: 8,
    churnPerTick: 3,
    cacheCleanBlocks: true,
  }),
  aging: Object.freeze({
    tickMs: 520,
    maxWritesPerTick: 36,
    noiseTickMs: 180,
    noisePerTick: 10,
    liveLimit: 28,
    liveRotateMs: 1000,
  }),
});

// A transition frame is allowed to cost this long before the machine is judged
// unable to hold the full budget. The bar is deliberately loose: the assembly
// is a few seconds of peak load, and demoting a machine that merely stutters
// once would cost more than it saves.
const SLOW_FRAME_MS = 42;
// Ignore the first frames of a transition — the scene build, the first atlas
// upload and the handoff all land there and none of them repeat.
const WARMUP_FRAMES = 8;
const SAMPLE_FRAMES = 46;
// Share of sampled frames that must be slow before dropping a tier.
const SLOW_SHARE = 0.4;

function runtimeSignals() {
  const nav = typeof navigator === "undefined" ? null : navigator;
  return {
    memory: nav?.deviceMemory,
    cores: nav?.hardwareConcurrency,
    touchPoints: nav?.maxTouchPoints || 0,
    coarse: Boolean(globalThis.matchMedia?.("(pointer: coarse)")?.matches),
    width: Number(globalThis.innerWidth) || 0,
    height: Number(globalThis.innerHeight) || 0,
  };
}

export function mobileTokenLimit(width, height) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (
    !Number.isFinite(safeWidth) || safeWidth <= 0
    || !Number.isFinite(safeHeight) || safeHeight <= 0
  ) {
    return MOBILE_MAX_TOKEN_LIMIT;
  }
  return Math.min(
    MOBILE_MAX_TOKEN_LIMIT,
    Math.max(
      MOBILE_MIN_TOKEN_LIMIT,
      Math.round(safeWidth * safeHeight / MOBILE_PIXELS_PER_TOKEN)
        * MOBILE_TOKEN_MULTIPLIER,
    ),
  );
}

export function detectQualityTier(signals = runtimeSignals()) {
  const {
    memory,
    cores,
    touchPoints = 0,
    coarse = false,
    width = 0,
    height = 0,
  } = signals;
  const shortSide = Math.min(Number(width) || 0, Number(height) || 0);

  if (
    coarse
    && touchPoints > 0
    && shortSide > 0
    && shortSide <= MOBILE_SHORT_SIDE_MAX
  ) {
    return "mobile";
  }

  // Chromium only, and bucketed to 0.25/0.5/1/2/4/8. Absent everywhere else,
  // which is why a missing value is never treated as evidence of weakness.
  if (typeof memory === "number" && memory > 0 && memory <= 4) return "lite";

  // Deliberately only the very low end. Four cores covers plenty of capable
  // machines, and demoting them up front would cost more than it saves — the
  // frame-cost sampler is a better judge and it runs a moment later.
  if (typeof cores === "number" && cores > 0 && cores <= 2) return "lite";

  // Preserve the old fallback for unusual coarse-pointer devices whose
  // browser exposes neither capability hint nor usable viewport/touch data.
  if (coarse && typeof memory !== "number" && typeof cores !== "number") return "lite";

  return "full";
}

// `initialTier` exists so the demotion path can be exercised without depending
// on whatever the host running the tests happens to report.
export function createQuality({ initialTier, signals } = {}) {
  const currentSignals = () => signals || runtimeSignals();
  let tier = initialTier || detectQualityTier(currentSignals());
  let demotedByMeasurement = false;
  let frames = 0;
  let slow = 0;
  let lastFrameAt = 0;

  return {
    get tier() {
      return tier;
    },

    get tokenLimit() {
      if (tier === "mobile") {
        const { width, height } = currentSignals();
        return mobileTokenLimit(width, height);
      }
      return tier === "lite" ? LITE_TOKEN_LIMIT : FULL_TOKEN_LIMIT;
    },

    get globalDprCap() {
      return tier === "mobile" ? MOBILE_GLOBAL_DPR_CAP : FULL_GLOBAL_DPR_CAP;
    },

    get localDprCap() {
      return tier === "mobile" ? MOBILE_LOCAL_DPR_CAP : FULL_LOCAL_DPR_CAP;
    },

    get performanceProfile() {
      return tier === "mobile"
        ? MOBILE_PERFORMANCE_PROFILE
        : FULL_PERFORMANCE_PROFILE;
    },

    // Called once per rendered transition frame. Returns true when the tier
    // just dropped, so the caller can throw away scenes built to the old
    // budget and rebuild at the new one.
    sample(now) {
      if (tier !== "full" || demotedByMeasurement) return false;
      const previous = lastFrameAt;
      lastFrameAt = now;
      if (!previous) return false;
      frames += 1;
      if (frames <= WARMUP_FRAMES) return false;
      if (now - previous > SLOW_FRAME_MS) slow += 1;
      if (frames < WARMUP_FRAMES + SAMPLE_FRAMES) return false;
      const share = slow / SAMPLE_FRAMES;
      frames = 0;
      slow = 0;
      if (share < SLOW_SHARE) return false;
      tier = "lite";
      demotedByMeasurement = true;
      return true;
    },

    // A transition has ended; the next one starts its own measurement.
    endSample() {
      frames = 0;
      slow = 0;
      lastFrameAt = 0;
    },
  };
}
