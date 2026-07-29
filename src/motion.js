import { CINNABAR_RGB, INK_RGB, PAPER, PAPER_RGB } from "./palette.js";

import { createAging, REVOLUTION_MS, titleNoise } from "./aging.js";
import { createAudio } from "./audio.js";
import { createAgingFavicon } from "./favicon.js";
import { formatLiveAge } from "./live-age.js";
import {
  IMAGE_TILE_TARGET,
  createPhotos,
  diffuseTileTarget,
  photoGrid,
} from "./photo.js";
import { createQuality } from "./quality.js";

const OWNER_FADE_MS = 180;
const MAX_VISUAL_GLYPHS = 9;
const MAX_NEW_VISUALS_PER_FRAME = 2;
const LOCAL_EFFECT_SOFT_LIMIT = 28;
const LOCAL_EFFECT_HARD_LIMIT = 40;
const LOCAL_RETIRED_EFFECT_LIMIT = 56;
const LOCAL_RETIRE_MS = 420;
const LOCAL_ACTIVE_FRAME_MS = 14;
const MIDPOINT_EFFECT_SOFT_LIMIT = 112;
const MIDPOINT_EFFECT_HARD_LIMIT = 160;
const MIDPOINT_RETIRED_EFFECT_LIMIT = 288;
const MIDPOINT_RETIRE_MS = 360;
const MIDPOINT_VISUAL_BURST = 72;
const MAX_NEW_MIDPOINT_VISUALS_PER_FRAME = 12;
const MIDPOINT_MAX_VISUAL_DISPLACEMENT = 108;
const WHOLE_IMAGE_FRAGMENT_START = 0.08;
const WHOLE_IMAGE_FRAGMENT_SPAN = 0.2;
const HANDOFF_FRAGMENT_RAMP = 0.06;
const TILED_IMAGE_OVERDRAW = 0.5;
// Charge accrual is a Map insert per character, not a rendered effect — the
// expensive visual work has its own separate budget — so this can be far
// more generous than it was when it also gated drawing. With no button on
// the page, a genuine sweep has to be able to reach the threshold.
const MAX_NEW_PER_FRAME = 40;
const MAX_NEW_MIDPOINT_PER_FRAME = 60;
const MAX_POINTER_SAMPLES = 20;
const MIDPOINT_IDLE_FRAME_MS = 30;
const MIDPOINT_ACTIVE_FRAME_MS = 14;
const MIDPOINT_PROGRESS = 0.46;
const CELL_SIZE = 72;
const TWO_PI = Math.PI * 2;

// A full 3 × 3 decomposition of the longer page is more than twenty thousand
// canvas sprites. The global scene keeps a dense but bounded, deterministic,
// role-stratified subset instead. Live hover glyphs are expanded back to all
// of their pieces at handoff, so the cap never creates a pop under the pointer.
export const GLOBAL_TRANSITION_TOKEN_LIMIT = 10000;

// The hand unwinds every turn it made, so the rewind is longer the longer you
// stayed — but it is a spin-back, not a scrub, so the per-turn cost is small
// and the whole thing is capped.
const CLOCK_REWIND_BASE_MS = 900;
const CLOCK_REWIND_PER_TURN_MS = 130;
const CLOCK_REWIND_MAX_MS = 3200;
const CLOCK_KEY_STEP_MS = 1000;

// The page never scrolls. Type is fitted to the viewport on mount and on
// resize by stepping the root size down until the content clears the box.
const FIT_MAX_PX = 16;
const FIT_MIN_PX = 8.5;
const FIT_STEP_PX = 0.25;

// E19 — the page's single colour event. Cinnabar blooms across the fragments
// the instant they arrive at the attractor and bleeds back to ink over half a
// second. Nothing else on the site is ever anything but black on paper.
const FLASH_ATTACK_MS = 90;
const FLASH_DECAY_MS = 430;

// How far the background loong is washed back behind the character at rest.
const MIDPOINT_WASH = 0.52;

// B6 — the assembled dragon does not hold a pose. It wanders on a slow
// two-axis drift, and its head leans toward the pointer while the body lags
// behind, which is what makes it read as an animal rather than an arrangement.
const SWIM_DRIFT_X = 15;
const SWIM_DRIFT_Y = 9;
const SWIM_SEEK_RANGE = 46;
const SWIM_SEEK_EASE = 0.42;
const SWIM_BODY_FOLLOW = 0.42;

const PARTICLE_MODES = new Set([
  "pearl-current",
  "negative-field",
]);
const POSED_FRAGMENT_MODES = new Set([
  "sigil-eye",
  "ink-depth",
  "dragon-bone",
]);
const LOCAL_DYNAMIC_MODES = new Set([
  ...PARTICLE_MODES,
  ...POSED_FRAGMENT_MODES,
]);
const MIDPOINT_DYNAMIC_MODES = new Set([
  ...PARTICLE_MODES,
  ...POSED_FRAGMENT_MODES,
]);
const ROTATING_TRANSITION_MODES = new Set([
  "sigil-eye",
  "ink-depth",
  "dragon-bone",
]);
const midpointAnchorCache = new Map();
const samplingMaskCache = new Map();

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, value));

// The clock is an unbounded dial. Incremental shortest-angle deltas preserve
// direction at twelve o'clock and allow any number of complete turns without
// snapping the hand to a modulo angle.
export function wrappedClockAngleDelta(previous, next) {
  const from = Number(previous);
  const to = Number(next);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const difference = to - from;
  return Math.atan2(Math.sin(difference), Math.cos(difference));
}

export function elapsedAfterClockDelta(currentElapsed, angleDelta) {
  const current = Number(currentElapsed);
  const delta = Number(angleDelta);
  if (!Number.isFinite(current) || !Number.isFinite(delta)) {
    return Math.max(0, Number.isFinite(current) ? current : 0);
  }
  return Math.max(0, current + delta / TWO_PI * REVOLUTION_MS);
}

function smoother(value) {
  const x = clamp(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function criticalSpringState(level, velocity, target, deltaSeconds, omega) {
  const displacement = level - target;
  const exponential = Math.exp(-omega * deltaSeconds);
  const combined = velocity + omega * displacement;
  return {
    level: target + (displacement + combined * deltaSeconds) * exponential,
    velocity: (velocity - omega * combined * deltaSeconds) * exponential,
  };
}

export function reserveEffectSlot(
  effects,
  softLimit,
  hardLimit,
  now,
  releaseHoldMs,
  retireEffect = null,
) {
  let disposableKey = null;
  let disposableScore = Number.POSITIVE_INFINITY;
  if (effects.size >= softLimit) {
    for (const [key, effect] of effects) {
      const releaseAge = effect.releaseStartedAt ? now - effect.releaseStartedAt : 0;
      if (
        releaseAge < releaseHoldMs
        || effect.target !== 0
        || effect.level >= 0.015
        || Math.abs(effect.levelVelocity || 0) >= 0.03
      ) continue;
      const score = effect.level * 100 + Math.abs(effect.levelVelocity || 0) + 1 / Math.max(1, releaseAge);
      if (score < disposableScore) {
        disposableScore = score;
        disposableKey = key;
      }
    }
  }
  if (disposableKey !== null) effects.delete(disposableKey);
  if (effects.size >= hardLimit && retireEffect) {
    let releasedKey = null;
    let releasedAt = Number.POSITIVE_INFINITY;
    for (const [key, effect] of effects) {
      if (!effect.releaseStartedAt || effect.releaseStartedAt >= releasedAt) continue;
      releasedAt = effect.releaseStartedAt;
      releasedKey = key;
    }
    if (releasedKey === null) {
      let weakestTarget = Number.POSITIVE_INFINITY;
      let weakestTouchedAt = Number.POSITIVE_INFINITY;
      for (const [key, effect] of effects) {
        const target = effect.target || 0;
        const touchedAt = effect.lastInsideAt || effect.createdAt || 0;
        if (
          target < weakestTarget
          || (target === weakestTarget && touchedAt < weakestTouchedAt)
        ) {
          weakestTarget = target;
          weakestTouchedAt = touchedAt;
          releasedKey = key;
        }
      }
    }
    if (releasedKey !== null) {
      const released = effects.get(releasedKey);
      if (retireEffect(releasedKey, released, now) !== false) {
        effects.delete(releasedKey);
      }
    }
  }
  // Freshly released letters are never sacrificed to make room. A short fast
  // jump may use the bounded reserve. Local rendering can supply a smooth
  // retiring tier at the hard cap; other callers still wait for a settled tail.
  return effects.size < hardLimit;
}

export function limitPointerSamples(points, limit = MAX_POINTER_SAMPLES) {
  const maximum = Math.max(2, Math.floor(Number(limit) || MAX_POINTER_SAMPLES));
  if (points.length <= maximum) return points;
  const endpoint = points.at(-1);
  const stride = Math.ceil((points.length - 1) / (maximum - 1));
  const limited = points
    .filter((_, index) => index % stride === 0)
    .slice(0, maximum - 1);
  const last = limited.at(-1);
  if (!last || last.x !== endpoint.x || last.y !== endpoint.y) limited.push(endpoint);
  return limited;
}

// The midpoint gate is expressed as a share of the particles that can
// actually be disturbed. Desktop keeps its calibrated 3,000 / 10,000 target;
// a smaller mobile scene keeps the same percentage instead of requiring the
// user to revisit particles that no longer exist in its quality budget.
export function particleScaledThreshold(
  configuredTarget,
  particleCount,
  referenceCount = GLOBAL_TRANSITION_TOKEN_LIMIT,
) {
  const target = Math.max(1, Math.round(Number(configuredTarget) || 1));
  const particles = Number(particleCount);
  const reference = Number(referenceCount);
  if (
    !Number.isFinite(particles) || particles <= 0
    || !Number.isFinite(reference) || reference <= 0
  ) return target;
  const boundedParticles = Math.min(particles, reference);
  return Math.max(
    1,
    Math.min(
      target,
      Math.floor(particles),
      Math.round(target * boundedParticles / reference),
    ),
  );
}

// A capture contains one entry per text glyph and per photograph tile. Image
// groups carry the number of entries they would have in the full desktop
// capture, so a mobile capture can preserve the established completion share
// even though it intentionally uses fewer photo tiles.
export function captureReferenceParticleCount(glyphs) {
  let count = 0;
  const imageGroups = new Set();
  for (const glyph of glyphs || []) {
    if (glyph.kind !== "image") {
      count += 1;
      continue;
    }
    if (imageGroups.has(glyph.imageGroupKey)) continue;
    imageGroups.add(glyph.imageGroupKey);
    count += Math.max(
      1,
      Math.floor(Number(glyph.imageReferenceParticleCount) || 1),
    );
  }
  return count;
}

function hash(value) {
  const result = Math.sin(value * 91.733 + 17.13) * 43758.5453;
  return result - Math.floor(result);
}

function hashString(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return Math.abs(result);
}

function loadSamplingMask(kind) {
  if (samplingMaskCache.has(kind)) return samplingMaskCache.get(kind);
  const load = (source) => new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load motion mask: ${source}`));
    image.src = source;
  });
  const promise = Promise.all([
    load("/oriental-loong-mask.avif").catch(() => null),
    load("/cursive-long-mask.png").catch(() => null),
  ]).then(([dragon, calligraphy]) => ({ dragon, calligraphy }));
  samplingMaskCache.set(kind, promise);
  return promise;
}

export function midpointVariantsFor(study, qualityTier = "full") {
  if (qualityTier === "mobile") {
    return [{ id: "oriental-dragon", label: "the dragon" }];
  }
  const variants = study.midpointVariants?.length
    ? study.midpointVariants
    : [{ id: study.midpoint, label: study.midpointName || "龍" }];
  return variants.map((variant) => (
    typeof variant === "string" ? { id: variant, label: variant } : variant
  ));
}

function chooseMidpointVariant(variants) {
  if (variants.length === 1) return variants[0];
  let value = Math.random();
  if (globalThis.crypto?.getRandomValues) {
    const random = new Uint32Array(1);
    globalThis.crypto.getRandomValues(random);
    value = random[0] / 0x100000000;
  }
  return variants[Math.min(variants.length - 1, Math.floor(value * variants.length))];
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function twoFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function waitForOpacityTransition(element, fallback = OWNER_FADE_MS + 80) {
  return new Promise((resolve) => {
    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      element.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === element && event.propertyName === "opacity") finish();
    };
    timer = setTimeout(finish, fallback);
    element.addEventListener("transitionend", onEnd);
  });
}

function canvasFont(style) {
  const computed = style.font?.trim();
  if (computed) return computed;
  return [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].filter(Boolean).join(" ");
}

function lineBaseline(context, font, fontSize, top, height) {
  context.font = font;
  const metrics = context.measureText("Mg");
  const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontSize * 0.2;
  return top + Math.max(0, height - ascent - descent) / 2 + ascent;
}

function graphemes(text) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), ({ segment, index }) => ({ segment, index }));
  }
  const result = [];
  let index = 0;
  for (const segment of Array.from(text)) {
    result.push({ segment, index });
    index += segment.length;
  }
  return result;
}

function setupCanvas(canvas, dprCap) {
  const width = innerWidth;
  const height = innerHeight;
  const areaCap = Math.sqrt(8000000 / Math.max(1, width * height));
  const dpr = Math.max(1, Math.min(dprCap, devicePixelRatio || 1, areaCap));
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d", { alpha: true });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width, height, dpr };
}

function prepareGlyphTokens(layer, face) {
  if (layer.dataset.glyphTokensReady === "true") return;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(".glyph-token, [data-ui], script, style, noscript")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  nodes.forEach((textNode, runIndex) => {
    const fragment = document.createDocumentFragment();
    let word = null;
    for (const item of graphemes(textNode.textContent || "")) {
      if (!item.segment.trim()) {
        word = null;
        fragment.append(document.createTextNode(item.segment));
        continue;
      }
      if (!word) {
        word = document.createElement("span");
        word.className = "glyph-word";
        // An inline nowrap wrapper is enough to make the word an atomic column
        // fragment without changing its baseline or native inline metrics.
        word.style.whiteSpace = "nowrap";
        fragment.append(word);
      }
      const token = document.createElement("span");
      token.className = "glyph-token";
      token.dataset.glyphKey = `${face}:${runIndex}:${item.index}`;
      token.dataset.character = item.segment;
      const ink = document.createElement("span");
      ink.className = "glyph-ink";
      ink.textContent = item.segment;
      const probe = document.createElement("i");
      probe.className = "glyph-baseline-probe";
      probe.setAttribute("aria-hidden", "true");
      token.append(ink, probe);
      word.append(token);
    }
    textNode.replaceWith(fragment);
  });
  layer.dataset.glyphTokensReady = "true";
}

function captureLayer(
  layer,
  measuringContext,
  imageTileTarget = IMAGE_TILE_TARGET,
) {
  const glyphs = [];
  const range = document.createRange();
  for (const token of layer.querySelectorAll(".glyph-token")) {
    const ink = token.querySelector(":scope > .glyph-ink");
    const probe = token.querySelector(":scope > .glyph-baseline-probe");
    const textNode = ink?.firstChild;
    if (!ink || !textNode) continue;
    const style = getComputedStyle(ink);
    if (style.display === "none" || style.visibility === "hidden") continue;
    range.selectNodeContents(ink);
    const rect = range.getClientRects().item(0) || range.getBoundingClientRect();
      if (
        rect.width < 0.15 || rect.height < 0.15 || rect.right < 0 ||
        rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight
      ) continue;
      const font = canvasFont(style);
      const fontSize = Number.parseFloat(style.fontSize) || 16;
      const measuredBaseline = probe?.getBoundingClientRect().top;
      glyphs.push({
        key: token.dataset.glyphKey,
        character: token.dataset.character,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        font,
        fontSize,
        color: style.color || "#000000",
        underline: style.textDecorationLine.includes("underline"),
        decorationColor: style.textDecorationColor || style.color || "#000000",
        baseline: Number.isFinite(measuredBaseline)
          ? measuredBaseline
          : lineBaseline(measuringContext, font, fontSize, rect.top, rect.height),
      });
  }
  range.detach();

  // Diffusable images are cut into tiles and pushed through the same pipeline
  // as text. Nothing downstream needs to know the difference: a tile has a
  // rect like a glyph, it subdivides like a glyph, and `drawGlyph` blits from
  // the bitmap instead of calling fillText.
  for (const image of layer.querySelectorAll("img[data-diffuse]")) {
    if (!image.complete || !image.naturalWidth) continue;
    const box = image.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) continue;
    // Tiles are sampled from the corruption canvas when there is one, so the
    // damage travels into the hover explosion and into the dragon without any
    // of that code knowing a photograph can be damaged.
    const bitmap = image.__photoSurface?.canvas || image;
    const { columns, rows } = imageCaptureGrid(
      image,
      box.width,
      box.height,
      imageTileTarget,
    );
    const referenceGrid = imageCaptureGrid(
      image,
      box.width,
      box.height,
      IMAGE_TILE_TARGET,
    );
    const imageReferenceParticleCount = referenceGrid.columns * referenceGrid.rows;
    const captureDpr = Math.max(
      1,
      Math.abs(measuringContext.getTransform?.().a || 1),
    );
    const columnBounds = imageGridBoundaries(
      box.left,
      box.width,
      columns,
      captureDpr,
    );
    const rowBounds = imageGridBoundaries(
      box.top,
      box.height,
      rows,
      captureDpr,
    );
    const bitmapWidth = bitmap.naturalWidth || bitmap.width;
    const bitmapHeight = bitmap.naturalHeight || bitmap.height;
    const scaleX = bitmapWidth / box.width;
    const scaleY = bitmapHeight / box.height;
    const baseKey = image.dataset.imageKey || "img";
    const wholeImage = image.hasAttribute("data-diffuse-whole");
    const imageGroupRect = {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = columnBounds[column];
        const right = columnBounds[column + 1];
        const top = rowBounds[row];
        const bottom = rowBounds[row + 1];
        const tileWidth = right - left;
        const tileHeight = bottom - top;
        if (
          right < 0 || bottom < 0
          || left > innerWidth || top > innerHeight
        ) continue;
        glyphs.push({
          key: wholeImage
            ? `${baseKey}:whole`
            : `${baseKey}:${column}:${row}`,
          kind: "image",
          wholeImage,
          imageGroupKey: baseKey,
          imageGroupRect: { ...imageGroupRect },
          imageReferenceParticleCount,
          image: bitmap,
          source: {
            x: (left - box.left) * scaleX,
            y: (top - box.top) * scaleY,
            width: tileWidth * scaleX,
            height: tileHeight * scaleY,
          },
          character: "",
          rect: {
            left,
            top,
            right,
            bottom,
            width: tileWidth,
            height: tileHeight,
          },
          font: "10px serif",
          fontSize: 10,
          color: "#000000",
          underline: false,
          decorationColor: "#000000",
          baseline: bottom,
        });
      }
    }
  }
  return glyphs;
}

// Tiny transparent marks should move as a single source surface. Their one
// glyph still splits into the study's 3 × 3 motion fragments, but erasing that
// glyph removes the whole logo at once instead of leaving a checkerboard of
// untouched image tiles. The underlying photo-corruption canvas keeps its
// detailed block grid.
export function imageCaptureGrid(
  image,
  width,
  height,
  targetCap = IMAGE_TILE_TARGET,
) {
  if (image?.hasAttribute?.("data-diffuse-whole")) {
    return { columns: 1, rows: 1 };
  }
  return photoGrid(
    width,
    height,
    Math.min(diffuseTileTarget(image), Math.max(16, targetCap)),
  );
}

// Internal tile edges share one device-pixel-snapped boundary. Adjacent
// source masks therefore meet exactly without either a translucent gap or
// overlapping alpha stripe. The outer edges stay faithful to the DOM image.
export function imageGridBoundaries(start, length, count, dpr = 1) {
  const segments = Math.max(1, Math.floor(count));
  const scale = Math.max(1, Number.isFinite(dpr) ? dpr : 1);
  return Array.from({ length: segments + 1 }, (_, index) => {
    if (index === 0) return start;
    if (index === segments) return start + length;
    return Math.round((start + length * index / segments) * scale) / scale;
  });
}

function drawGlyph(context, glyph, alpha = 1) {
  if (glyph.kind === "image") {
    const { source, rect } = glyph;
    const overdraw = glyph.wholeImage ? 0 : TILED_IMAGE_OVERDRAW;
    context.globalAlpha = alpha;
    // Half a pixel of overdraw so neighbouring tiles do not leave hairline
    // seams across photographs. Whole marks have no neighbouring source tile,
    // so they stay at their exact size and cannot leave a right/bottom halo.
    context.drawImage(
      glyph.image,
      source.x, source.y, source.width, source.height,
      rect.left, rect.top, rect.width + overdraw, rect.height + overdraw,
    );
    context.globalAlpha = 1;
    return;
  }
  context.globalAlpha = alpha;
  context.font = glyph.font;
  context.fillStyle = glyph.color;
  context.textBaseline = "alphabetic";
  context.fillText(glyph.character, glyph.rect.left, glyph.baseline);
  if (glyph.underline) {
    const thickness = Math.max(0.65, glyph.fontSize * 0.055);
    context.fillStyle = glyph.decorationColor;
    context.fillRect(
      glyph.rect.left,
      Math.min(glyph.rect.bottom - thickness, glyph.baseline + glyph.fontSize * 0.08),
      glyph.rect.width,
      thickness,
    );
  }
  context.globalAlpha = 1;
}

function drawStructuralChrome(context, layer) {
  context.save();
  for (const rule of layer.querySelectorAll("hr")) {
    const rect = rule.getBoundingClientRect();
    context.fillStyle = "#888";
    context.fillRect(rect.left, rect.top + rect.height / 2, rect.width, 1);
  }
  for (const fieldset of layer.querySelectorAll("fieldset")) {
    const rect = fieldset.getBoundingClientRect();
    context.strokeStyle = "#777";
    context.lineWidth = 1;
    context.strokeRect(rect.left + 0.5, rect.top + 0.5, rect.width - 1, rect.height - 1);
    const legend = fieldset.querySelector(":scope > legend");
    if (legend) {
      const legendRect = legend.getBoundingClientRect();
      context.fillStyle = PAPER;
      context.fillRect(legendRect.left - 3, rect.top, legendRect.width + 6, 2);
    }
  }
  for (const summary of layer.querySelectorAll("summary")) {
    const rect = summary.getBoundingClientRect();
    const open = summary.parentElement?.hasAttribute("open");
    context.fillStyle = "#000";
    context.beginPath();
    if (open) {
      context.moveTo(rect.left - 13, rect.top + 5);
      context.lineTo(rect.left - 5, rect.top + 5);
      context.lineTo(rect.left - 9, rect.top + 11);
    } else {
      context.moveTo(rect.left - 11, rect.top + 3);
      context.lineTo(rect.left - 11, rect.top + 11);
      context.lineTo(rect.left - 5, rect.top + 7);
    }
    context.closePath();
    context.fill();
  }
  for (const item of layer.querySelectorAll("li")) {
    const rect = item.getBoundingClientRect();
    const style = getComputedStyle(item);
    if (style.listStyleType === "none") continue;
    const parent = item.parentElement;
    let marker = "•";
    if (parent?.tagName === "OL") {
      marker = `${Array.from(parent.children).indexOf(item) + 1}.`;
    }
    const font = canvasFont(style);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    context.font = font;
    context.fillStyle = style.color || "#000";
    context.textAlign = "right";
    context.textBaseline = "alphabetic";
    context.fillText(marker, rect.left - fontSize * 0.38, lineBaseline(context, font, fontSize, rect.top, Math.min(rect.height, fontSize * 1.4)));
  }
  context.restore();
}

function rasterLayer(glyphs, layer, width, height, dpr) {
  const atlas = document.createElement("canvas");
  atlas.width = Math.max(1, Math.round(width * dpr));
  atlas.height = Math.max(1, Math.round(height * dpr));
  const context = atlas.getContext("2d", { alpha: true });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawStructuralChrome(context, layer);
  for (const glyph of glyphs) drawGlyph(context, glyph);
  return atlas;
}

function rasterChrome(layer, width, height, dpr) {
  const atlas = document.createElement("canvas");
  atlas.width = Math.max(1, Math.round(width * dpr));
  atlas.height = Math.max(1, Math.round(height * dpr));
  const context = atlas.getContext("2d", { alpha: true });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawStructuralChrome(context, layer);
  return atlas;
}

function distanceToRect(x, y, rect) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

function cellKey(column, row) {
  return `${column}:${row}`;
}

function spatialIndex(glyphs) {
  const cells = new Map();
  for (const glyph of glyphs) {
    const left = Math.floor(glyph.rect.left / CELL_SIZE);
    const right = Math.floor(glyph.rect.right / CELL_SIZE);
    const top = Math.floor(glyph.rect.top / CELL_SIZE);
    const bottom = Math.floor(glyph.rect.bottom / CELL_SIZE);
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const key = cellKey(column, row);
        const bucket = cells.get(key) || [];
        bucket.push(glyph);
        cells.set(key, bucket);
      }
    }
  }
  return cells;
}

function nearbyGlyphs(index, point, radius) {
  const results = new Map();
  const left = Math.floor((point.x - radius) / CELL_SIZE);
  const right = Math.floor((point.x + radius) / CELL_SIZE);
  const top = Math.floor((point.y - radius) / CELL_SIZE);
  const bottom = Math.floor((point.y + radius) / CELL_SIZE);
  for (let row = top; row <= bottom; row += 1) {
    for (let column = left; column <= right; column += 1) {
      for (const glyph of index.get(cellKey(column, row)) || []) {
        if (results.has(glyph.key)) continue;
        const distance = distanceToRect(point.x, point.y, glyph.rect);
        if (distance <= radius) results.set(glyph.key, { glyph, distance });
      }
    }
  }
  return Array.from(results.values()).sort((a, b) => a.distance - b.distance);
}

function midpointSpatialIndex(tokens) {
  const cells = new Map();
  tokens.forEach((token, index) => {
    const column = Math.floor(token.midpoint.x / CELL_SIZE);
    const row = Math.floor(token.midpoint.y / CELL_SIZE);
    const key = cellKey(column, row);
    const bucket = cells.get(key) || [];
    bucket.push(index);
    cells.set(key, bucket);
  });
  return cells;
}

function nearbyMidpointTokens(
  scene,
  point,
  radius,
  now,
  activeEffects = null,
  retiredEffects = null,
  visualAnchorCache = null,
) {
  const results = [];
  const seen = new Set();
  const queryRadius = radius + MIDPOINT_MAX_VISUAL_DISPLACEMENT;
  const left = Math.floor((point.x - queryRadius) / CELL_SIZE);
  const right = Math.floor((point.x + queryRadius) / CELL_SIZE);
  const top = Math.floor((point.y - queryRadius) / CELL_SIZE);
  const bottom = Math.floor((point.y + queryRadius) / CELL_SIZE);
  for (let row = top; row <= bottom; row += 1) {
    for (let column = left; column <= right; column += 1) {
      for (const index of scene.midpointIndex.get(cellKey(column, row)) || []) {
        if (seen.has(index)) continue;
        seen.add(index);
        const token = scene.tokens[index];
        let visual = visualAnchorCache?.get(index);
        if (!visual) {
          visual = midpointVisualAnchor(
            scene,
            token,
            index,
            now,
            activeEffects,
            retiredEffects,
          );
          visualAnchorCache?.set(index, visual);
        }
        const distance = Math.hypot(point.x - visual.x, point.y - visual.y);
        if (distance <= radius) results.push({ index, token, distance, visual });
      }
    }
  }
  return results.sort((a, b) => a.distance - b.distance);
}

function fragmentLayout(glyph, mode, shapeCache = null, detail = "local") {
  if (PARTICLE_MODES.has(mode)) {
    const area = Math.max(1, glyph.rect.width * glyph.rect.height);
    // Local hover can afford a dense glyph. The page-wide system uses a
    // stratified subset so rich copy never turns into 40k–100k animated
    // tokens. The low-discrepancy sampler keeps the two prefixes identical,
    // allowing an exact live-particle handoff.
    const count = detail === "transition"
      ? Math.round(clamp(area * 0.055, 8, 28))
      : Math.round(clamp(area * 0.17, 30, 112));
    return sampleGlyphInk(glyph, count, shapeCache).map((point, index) => {
      const size = clamp(point.size * 1.08, 0.9, 2.15);
      return {
        x: glyph.rect.left + point.x - size / 2,
        y: glyph.rect.top + point.y - size / 2,
        width: size,
        height: size,
        particle: true,
        color: glyph.color,
        point,
        glyphKey: glyph.key,
        pieceIndex: index,
        sourceId: `${glyph.key}:particle:${index}`,
        seed: hashString(glyph.key) + index * 29,
      };
    });
  }
  if (mode === "shard-glass" || mode === "fracture-cascade") {
    const { left: x, top: y, width, height } = glyph.rect;
    const polygons = mode === "shard-glass"
      ? [
          [[0, 0], [1, 0], [0.52, 0.46]],
          [[1, 0], [1, 1], [0.52, 0.46]],
          [[1, 1], [0, 1], [0.52, 0.46]],
          [[0, 1], [0, 0], [0.52, 0.46]],
        ]
      : [
          [[0, 0], [0.5, 0], [0.5, 0.5]],
          [[0.5, 0], [1, 0], [0.5, 0.5]],
          [[1, 0], [1, 1], [0.5, 0.5]],
          [[1, 1], [0.5, 1], [0.5, 0.5]],
          [[0.5, 1], [0, 1], [0.5, 0.5]],
          [[0, 1], [0, 0], [0.5, 0.5]],
        ];
    return polygons.map((polygon, index) => ({
      x,
      y,
      width,
      height,
      polygon,
      glyphKey: glyph.key,
      pieceIndex: index,
      sourceId: `${glyph.key}:fragment:${index}`,
      seed: hashString(glyph.key) + index * 29,
    }));
  }
  let columns = 2;
  let rows = 2;
  if (mode === "stroke-loong") [columns, rows] = [1, 7];
  if (mode === "fluid-ink") [columns, rows] = [2, 4];
  if (mode === "morphogen") [columns, rows] = [3, 3];
  if (mode === "page-fault") [columns, rows] = [1, 6];
  if (mode === "quadtree-fold") [columns, rows] = [2, 3];
  if (mode === "standing-wave") [columns, rows] = [1, 8];
  if (mode === "magnetic-shards") [columns, rows] = [3, 3];
  if (mode === "calligraphic-shards") [columns, rows] = [7, 1];
  if (mode === "echo-shards") [columns, rows] = [2, 3];
  if (mode === "moire-wave") [columns, rows] = [1, 8];
  if (mode === "soliton-wave") [columns, rows] = [1, 8];
  if (mode === "seismic-wave") [columns, rows] = [3, 1];
  if (mode === "interference-wave") [columns, rows] = [3, 3];
  if (mode === "cellular") [columns, rows] = [3, 4];
  if (mode === "woven") [columns, rows] = [7, 1];
  if (mode === "scale-current") [columns, rows] = [3, 3];
  if (mode === "laminar-loong") [columns, rows] = [1, 9];
  if (mode === "brushwake") [columns, rows] = [9, 1];
  if (mode === "dual-attractor") [columns, rows] = [3, 3];
  if (mode === "sigil-eye") [columns, rows] = [3, 3];
  if (mode === "ink-depth") [columns, rows] = [9, 1];
  if (mode === "dragon-bone") [columns, rows] = [2, 5];
  const pieces = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const width = glyph.rect.width / columns;
      const height = glyph.rect.height / rows;
      const pieceIndex = row * columns + column;
      pieces.push({
        x: glyph.rect.left + column * width,
        y: glyph.rect.top + row * height,
        width,
        height,
        column,
        row,
        columns,
        rows,
        imageTile: glyph.kind === "image",
        glyphKey: glyph.key,
        pieceIndex,
        sourceId: `${glyph.key}:fragment:${pieceIndex}`,
        seed: hashString(glyph.key) + row * 31 + column * 17,
      });
    }
  }
  return pieces;
}

function allFragments(glyphs, mode, shapeCache = null) {
  return glyphs.flatMap((glyph) => fragmentLayout(glyph, mode, shapeCache, "transition"));
}

function evenlySample(entries, count) {
  if (count >= entries.length) return entries.slice();
  return Array.from({ length: count }, (_, index) => (
    entries[Math.min(
      entries.length - 1,
      Math.floor((index + 0.5) * entries.length / count),
    )]
  ));
}

// Preserve both material roles (type versus photograph) and every fitted-piece
// position. Sampling each stratum evenly also keeps coverage distributed over
// the whole document instead of taking a dense prefix from its first column.
export function limitTransitionFragments(
  fragments,
  limit = GLOBAL_TRANSITION_TOKEN_LIMIT,
) {
  const maximum = Math.max(0, Math.floor(limit));
  if (fragments.length <= maximum) return fragments.slice();
  if (!maximum) return [];

  const strata = new Map();
  fragments.forEach((fragment, index) => {
    const role = fragment.imageTile ? "image" : "type";
    const key = `${role}:${fragment.pieceIndex ?? 0}`;
    const entries = strata.get(key) || [];
    entries.push({ fragment, index });
    strata.set(key, entries);
  });
  const groups = [...strata.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entries]) => ({ key, entries, quota: 0, remainder: 0 }));

  // Give every non-empty role/piece stratum one representative when possible,
  // then distribute the rest proportionally using largest remainders.
  let remaining = maximum;
  if (remaining >= groups.length) {
    for (const group of groups) {
      group.quota = 1;
      remaining -= 1;
    }
  }
  const available = groups.reduce(
    (total, group) => total + Math.max(0, group.entries.length - group.quota),
    0,
  );
  if (remaining > 0 && available > 0) {
    for (const group of groups) {
      const capacity = Math.max(0, group.entries.length - group.quota);
      const exact = remaining * capacity / available;
      const addition = Math.min(capacity, Math.floor(exact));
      group.quota += addition;
      group.remainder = exact - addition;
    }
    let assigned = groups.reduce((total, group) => total + group.quota, 0);
    const byRemainder = [...groups].sort((left, right) => (
      right.remainder - left.remainder
      || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    ));
    while (assigned < maximum) {
      let changed = false;
      for (const group of byRemainder) {
        if (group.quota >= group.entries.length) continue;
        group.quota += 1;
        assigned += 1;
        changed = true;
        if (assigned >= maximum) break;
      }
      if (!changed) break;
    }
  }

  return groups
    .flatMap((group) => evenlySample(group.entries, group.quota))
    .sort((left, right) => left.index - right.index)
    .map(({ fragment }) => fragment);
}

function assignSparse(values, slots) {
  const output = Array(slots).fill(null);
  if (!values.length) return output;
  if (values.length === 1) {
    output[Math.floor(slots / 2)] = values[0];
    return output;
  }
  let previous = -1;
  values.forEach((value, index) => {
    let slot = Math.round(index * (slots - 1) / (values.length - 1));
    slot = Math.max(previous + 1, Math.min(slots - (values.length - index), slot));
    output[slot] = value;
    previous = slot;
  });
  return output;
}

function drawLoongMask(context, width, height) {
  const scale = Math.min(width, height);
  context.strokeStyle = "#000";
  context.fillStyle = "#000";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(11, scale * 0.055);
  context.beginPath();
  context.moveTo(width * 0.08, height * 0.56);
  context.bezierCurveTo(width * 0.2, height * 0.12, width * 0.34, height * 0.88, width * 0.48, height * 0.5);
  context.bezierCurveTo(width * 0.59, height * 0.19, width * 0.68, height * 0.7, width * 0.79, height * 0.42);
  context.stroke();

  context.lineWidth = Math.max(3, scale * 0.009);
  for (let index = 0; index < 22; index += 1) {
    const t = index / 21;
    const x = width * (0.11 + t * 0.65);
    const y = height * (0.51 + Math.sin(t * Math.PI * 4.25) * 0.105);
    context.beginPath();
    context.arc(x, y, scale * 0.018, Math.PI * 0.1, Math.PI * 0.9);
    context.stroke();
  }

  const headX = width * 0.82;
  const headY = height * 0.4;
  context.beginPath();
  context.ellipse(headX, headY, scale * 0.09, scale * 0.067, -0.18, 0, TWO_PI);
  context.fill();
  context.fillRect(headX + scale * 0.045, headY - scale * 0.012, scale * 0.1, scale * 0.045);
  context.clearRect(headX + scale * 0.045, headY + scale * 0.006, scale * 0.035, scale * 0.012);
  for (const eye of [-1, 1]) {
    context.beginPath();
    context.arc(headX + scale * 0.018, headY + eye * scale * 0.025, scale * 0.008, 0, TWO_PI);
    context.fill();
  }

  context.lineWidth = Math.max(4, scale * 0.014);
  for (const sign of [-1, 1]) {
    context.beginPath();
    context.moveTo(headX - scale * 0.025, headY - scale * 0.04);
    context.bezierCurveTo(headX - scale * 0.02, headY - scale * 0.14, headX + sign * scale * 0.035, headY - scale * 0.16, headX + sign * scale * 0.055, headY - scale * 0.21);
    context.stroke();
    context.beginPath();
    context.moveTo(headX + scale * 0.05, headY + sign * scale * 0.025);
    context.bezierCurveTo(headX + scale * 0.15, headY + sign * scale * 0.02, headX + scale * 0.12, headY + sign * scale * 0.12, headX + scale * 0.19, headY + sign * scale * 0.13);
    context.stroke();
  }

  for (const [x, y, direction] of [[0.31, 0.48, -1], [0.46, 0.57, 1], [0.59, 0.38, -1], [0.7, 0.5, 1]]) {
    context.lineWidth = Math.max(5, scale * 0.018);
    context.beginPath();
    context.moveTo(width * x, height * y);
    context.lineTo(width * (x + 0.025), height * (y + direction * 0.14));
    context.lineTo(width * (x + 0.065), height * (y + direction * 0.2));
    context.stroke();
    for (let claw = -1; claw <= 1; claw += 1) {
      context.beginPath();
      context.moveTo(width * (x + 0.065), height * (y + direction * 0.2));
      context.lineTo(width * (x + 0.085 + claw * 0.015), height * (y + direction * 0.23));
      context.stroke();
    }
  }
}

function maskCandidates(image, rect, motif, maskWidth, maskHeight, renderScale, count) {
  const mask = document.createElement("canvas");
  mask.width = maskWidth;
  mask.height = maskHeight;
  const context = mask.getContext("2d", { willReadFrequently: true });
  context.fillStyle = PAPER;
  context.fillRect(0, 0, maskWidth, maskHeight);
  if (image) {
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  } else if (motif === "dragon") {
    // A failed AVIF decode must not collapse the valid calligraphy (or the
    // whole formation) to one point. This restrained parametric loong is only
    // a recovery path; normal rendering uses the detailed inspected mask.
    drawLoongMask(context, maskWidth, maskHeight);
  } else {
    const fontSize = Math.min(rect.width * 0.92, rect.height * 0.92);
    context.fillStyle = "#000";
    context.font = `italic 700 ${fontSize}px "Songti SC", "STSong", serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("龍", rect.x + rect.width / 2, rect.y + rect.height / 2);
  }
  const pixels = context.getImageData(0, 0, maskWidth, maskHeight).data;
  const candidates = [];
  // Ten thousand rendered fragments do not need a full-pixel mask scan: the
  // step-2 lattice already supplies ample candidates and avoids quadrupling
  // scene-prewarm work just because the display cap crossed 9,000.
  const step = count > 16000 ? 1 : count > 3200 ? 2 : 3;
  for (let y = 0; y < maskHeight; y += step) {
    for (let x = 0; x < maskWidth; x += step) {
      const offset = (y * maskWidth + x) * 4;
      const alpha = pixels[offset + 3] / 255;
      const luminance = (
        pixels[offset] * 0.2126
        + pixels[offset + 1] * 0.7152
        + pixels[offset + 2] * 0.0722
      ) / 255;
      if (
        alpha > 0.12
        && luminance < 0.79
        && hash(x * 0.73 + y * 1.17 + (motif === "calligraphy" ? 913 : 0))
          < clamp((1 - luminance) * 1.44, 0.18, 1)
      ) {
        candidates.push({ x: x / renderScale, y: y / renderScale, motif });
      }
    }
  }
  candidates.sort((a, b) => {
    const bandA = Math.floor(a.y / Math.max(1, maskHeight / renderScale) * 104);
    const bandB = Math.floor(b.y / Math.max(1, maskHeight / renderScale) * 104);
    if (bandA !== bandB) return bandA - bandB;
    return bandA % 2 ? b.x - a.x : a.x - b.x;
  });
  return candidates;
}

function sampleCandidateLayer(candidates, count, seed) {
  if (!candidates.length) return [];
  return Array.from({ length: count }, (_, index) => {
    const stratum = (index + 0.5) * candidates.length / count;
    const spread = Math.max(1, candidates.length / count);
    const candidateIndex = Math.floor(clamp(
      stratum + (hash(seed + index * 7.3) - 0.5) * spread * 0.86,
      0,
      candidates.length - 1,
    ));
    return candidates[candidateIndex];
  });
}

function midpointAnchors(count, width, height, kind, maskImages) {
  const cacheKey = `${kind}:${count}:${Math.round(width)}:${Math.round(height)}`;
  if (midpointAnchorCache.has(cacheKey)) return midpointAnchorCache.get(cacheKey);
  const renderScale = Math.min(1, 960 / Math.max(width, height));
  const maskWidth = Math.max(1, Math.round(width * renderScale));
  const maskHeight = Math.max(1, Math.round(height * renderScale));
  const configurations = {
    "dragon-eye": { ratio: 0.21, center: [0.19, 0.35], size: 0.135, dragonScale: [0.94, 0.78] },
    "calligraphic-pearl": { ratio: 0.23, center: [0.085, 0.575], size: 0.18, dragonScale: [0.93, 0.77] },
    "calligraphic-shadow": { ratio: 0.34, center: [0.6, 0.57], size: 0.56, dragonScale: [0.86, 0.7] },
    "negative-heart": { ratio: 0.2, center: [0.55, 0.52], size: 0.3, dragonScale: [0.92, 0.76] },
    "dragon-skeleton": { ratio: 0.36, center: [0.52, 0.5], size: 0.5, dragonScale: [0.9, 0.74] },
    "oriental-dragon": { ratio: 0, center: [0.5, 0.5], size: 0, dragonScale: [0.94, 0.78] },
    "cursive-long": {
      ratio: 1,
      center: [0.5, 0.5],
      size: 1.25,
      dragonScale: [0.94, 0.78],
      directCalligraphy: true,
    },
    // The seal: a heavy cursive 龍 standing in front of a loong that fills the
    // frame behind it. Nearly half the fragments go to the character, packed
    // into a fraction of the area, which is what makes it read as solid brush
    // against a thin wash.
    "seal-loong": {
      ratio: 0.46,
      center: [0.5, 0.47],
      size: 0.78,
      dragonScale: [0.84, 0.98],
      directCalligraphy: true,
    },
  };
  const configuration = configurations[kind] || configurations["dragon-eye"];
  const dragonImage = maskImages?.dragon;
  const dragonSourceWidth = dragonImage?.naturalWidth || dragonImage?.width || 1;
  const dragonSourceHeight = dragonImage?.naturalHeight || dragonImage?.height || 1;
  const dragonAvailableWidth = maskWidth * configuration.dragonScale[0];
  const dragonAvailableHeight = maskHeight * configuration.dragonScale[1];
  const dragonFit = Math.min(
    dragonAvailableWidth / dragonSourceWidth,
    dragonAvailableHeight / dragonSourceHeight,
  );
  const dragonRect = {
    width: dragonSourceWidth * dragonFit,
    height: dragonSourceHeight * dragonFit,
  };
  dragonRect.x = (maskWidth - dragonRect.width) / 2;
  dragonRect.y = (maskHeight - dragonRect.height) / 2;
  const calligraphySize = Math.min(maskWidth, maskHeight) * configuration.size;
  const calligraphyCenter = configuration.directCalligraphy
    ? { x: maskWidth * configuration.center[0], y: maskHeight * configuration.center[1] }
    : {
        x: dragonRect.x + dragonRect.width * configuration.center[0],
        y: dragonRect.y + dragonRect.height * configuration.center[1],
      };
  const calligraphyRect = {
    x: calligraphyCenter.x - calligraphySize / 2,
    y: calligraphyCenter.y - calligraphySize / 2,
    width: calligraphySize,
    height: calligraphySize,
  };
  const calligraphyCount = Math.round(count * configuration.ratio);
  const dragonCount = Math.max(0, count - calligraphyCount);
  const dragonCandidates = dragonCount
    ? maskCandidates(
        dragonImage,
        dragonRect,
        "dragon",
        maskWidth,
        maskHeight,
        renderScale,
        dragonCount,
      )
    : [];
  const calligraphyCandidates = calligraphyCount
    ? maskCandidates(
        maskImages?.calligraphy,
        calligraphyRect,
        "calligraphy",
        maskWidth,
        maskHeight,
        renderScale,
        calligraphyCount,
      )
    : [];
  const anchors = [
    ...sampleCandidateLayer(dragonCandidates, dragonCount, 73),
    ...sampleCandidateLayer(calligraphyCandidates, calligraphyCount, 947),
  ].sort((a, b) => hash(a.x * 0.31 + a.y * 0.71) - hash(b.x * 0.31 + b.y * 0.71));
  if (!anchors.length) {
    anchors.push(...Array.from({ length: count }, (_, index) => ({
      x: width / 2,
      y: height / 2,
      motif: configuration.ratio === 1
        ? "calligraphy"
        : configuration.ratio === 0
          ? "dragon"
          : index % 5 ? "dragon" : "calligraphy",
    })));
  }
  midpointAnchorCache.set(cacheKey, anchors);
  if (midpointAnchorCache.size > 8) midpointAnchorCache.delete(midpointAnchorCache.keys().next().value);
  return anchors;
}

function makeTransitionTokens(
  sourceGlyphs,
  targetGlyphs,
  study,
  width,
  height,
  shapeCache,
  maskImage,
  midpointKind = study.midpoint,
  tokenLimit = GLOBAL_TRANSITION_TOKEN_LIMIT,
) {
  const source = limitTransitionFragments(
    allFragments(sourceGlyphs, study.mode, shapeCache),
    tokenLimit,
  );
  const target = limitTransitionFragments(
    allFragments(targetGlyphs, study.mode, shapeCache),
    tokenLimit,
  );
  const slots = Math.max(source.length, target.length);
  const sourceSlots = assignSparse(source, slots);
  const targetSlots = assignSparse(target, slots);
  const midpoint = midpointAnchors(
    slots,
    Math.round(width),
    Math.round(height),
    midpointKind,
    maskImage,
  );
  // Which fragment lands where is biased by what the fragment *is*: the type
  // builds the character and the photographs build the wash behind it. Both
  // orderings are stable, so the hash-scatter inside each group survives and
  // the loong is still assembled from pieces drawn from all over the page.
  const slotIsPhotograph = (index) => Boolean(
    (sourceSlots[index] || source[index % source.length])?.imageTile,
  );
  const slotOrder = Array.from({ length: slots }, (_, index) => index)
    .sort((a, b) => Number(slotIsPhotograph(a)) - Number(slotIsPhotograph(b)));
  const anchorsByRole = [...midpoint]
    .sort((a, b) => (a.motif === "calligraphy" ? 0 : 1) - (b.motif === "calligraphy" ? 0 : 1));
  const anchorForSlot = new Array(slots);
  slotOrder.forEach((slot, rank) => {
    anchorForSlot[slot] = anchorsByRole[rank] || midpoint[slot];
  });

  const tokens = Array.from({ length: slots }, (_, index) => {
    const sourceOrigin = sourceSlots[index] || source[index % source.length];
    const targetDestination = targetSlots[index] || target[index % target.length];
    const mid = anchorForSlot[index];
    return {
      index,
      source: sourceSlots[index],
      target: targetSlots[index],
      sourceInk: sourceSlots[index] || source[index % source.length],
      targetInk: targetSlots[index] || target[index % target.length],
      sourceOrigin,
      targetDestination,
      sourceCenter: center(sourceOrigin, mid),
      targetCenter: center(targetDestination, mid),
      midpoint: mid,
      midpointRole: mid.motif,
      sourceId: sourceSlots[index]?.sourceId || null,
      seed: hash(index * 17.31 + Number(study.number) * 101),
      fieldPhase: hash(index * 9.71 + Number(study.number) * 53) * TWO_PI,
      fieldSign: index % 2 ? -1 : 1,
      depth: hash(index * 5.93 + Number(study.number) * 17) * 2 - 1,
    };
  });
  return tokens;
}

function midpointBounds(tokens, width, height) {
  if (!tokens.length) return { left: 0, top: 0, width, height };
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { midpoint } of tokens) {
    left = Math.min(left, midpoint.x);
    right = Math.max(right, midpoint.x);
    top = Math.min(top, midpoint.y);
    bottom = Math.max(bottom, midpoint.y);
  }
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function center(piece, fallback) {
  return piece
    ? { x: piece.x + piece.width / 2, y: piece.y + piece.height / 2 }
    : fallback;
}

function trajectoryOffset(mode, t, index, seed, from, to, width, height, motif = "dragon") {
  // Zero slope at both attractors keeps the sampled local velocity intact at
  // the ownership handoff and lets fragments arrive without a terminal kick.
  const envelope = Math.sin(Math.PI * clamp(t)) ** 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const normalX = -dy / length;
  const normalY = dx / length;
  let x = 0;
  let y = 0;
  let scale = 0;
  let rotation = 0;
  switch (mode) {
    case "sigil-eye": {
      const sign = index % 2 ? -1 : 1;
      const phase = t * TWO_PI * (1.25 + seed * 0.8) + sign * index * 0.083;
      const orbit = (motif === "calligraphy" ? 42 : 68) + seed * (motif === "calligraphy" ? 58 : 112);
      const braid = orbit * envelope;
      x = Math.cos(phase) * braid + sign * width * 0.072 * envelope * (1 - t);
      y = Math.sin(phase) * braid * 0.68 + sign * 25 * envelope;
      rotation = sign * envelope * (0.18 + seed * 0.3);
      break;
    }
    case "pearl-current": {
      const wake = smoother(clamp(t * 1.55 - hash(index * 0.29) * 0.48));
      const curl = Math.sin(t * TWO_PI * (1.2 + seed * 1.1) + index * 0.17);
      const magnitude = (motif === "calligraphy" ? 92 : 148) * envelope;
      x = dx / length * width * 0.09 * wake * envelope + normalX * curl * magnitude;
      y = dy / length * height * 0.06 * wake * envelope + normalY * curl * magnitude;
      break;
    }
    case "ink-depth": {
      const depth = seed * 2 - 1;
      const perspective = envelope * depth;
      const ribbon = Math.sin(t * TWO_PI * 1.8 + index * 0.23) * (48 + seed * 74);
      x = normalX * ribbon * envelope + (from.x - width / 2) * perspective * 0.16;
      y = normalY * ribbon * envelope + (from.y - height / 2) * perspective * 0.12 - depth * 48 * envelope;
      scale = depth * 0.22 * envelope;
      rotation = depth * 0.09 * envelope;
      break;
    }
    case "negative-field": {
      const angle = seed * TWO_PI + Math.sin(index * 0.61) * 0.55;
      const annulus = (74 + seed * 156) * Math.sin(Math.PI * t) ** 1.4;
      const close = Math.sin(t * TWO_PI * 2 + index * 0.11) * 34 * envelope;
      x = Math.cos(angle) * annulus + normalX * close;
      y = Math.sin(angle) * annulus * 0.72 + normalY * close;
      break;
    }
    case "dragon-bone": {
      const order = (index % 37) / 36;
      const writing = smoother(clamp(t * 1.45 - order * 0.45));
      const pressure = Math.sin(writing * Math.PI) * (80 + seed * 118);
      const hook = Math.sin(writing * TWO_PI * 2.2 + index * 0.19) * 32;
      x = (normalX * pressure + dx / length * hook) * envelope;
      y = (normalY * pressure + dy / length * hook) * envelope;
      rotation = (seed - 0.5) * 0.44 * envelope;
      break;
    }
    case "powder-wind": {
      const front = smoother(clamp(t * 1.55 - hash(index * 0.37) * 0.55));
      const curl = Math.sin(t * TWO_PI * (1.7 + seed) + index * 0.11) * (42 + seed * 76);
      x = (width * (0.18 + seed * 0.12) * front + normalX * curl) * envelope;
      y = (normalY * curl + Math.sin(index * 0.91 + t * 13) * 28) * envelope;
      break;
    }
    case "latent-diffusion": {
      const curl = Math.sin(t * TWO_PI * (1.5 + seed * 2) + index) * (26 + seed * 54);
      x = normalX * curl * envelope + Math.sin(index * 3.1 + t * 19) * 8 * envelope;
      y = normalY * curl * envelope + Math.cos(index * 2.3 + t * 17) * 8 * envelope;
      break;
    }
    case "shard-glass": {
      const angle = seed * TWO_PI;
      const blast = (72 + seed * 138) * envelope;
      const curl = Math.sin(t * TWO_PI + index * 0.17) * (24 + seed * 42) * envelope;
      x = Math.cos(angle) * blast + normalX * curl;
      y = Math.sin(angle) * blast + normalY * curl - 58 * envelope * envelope;
      break;
    }
    case "fracture-cascade": {
      const front = clamp(t * 1.35 - (index % 17) / 17 * 0.35);
      const impulse = smoother(front) * envelope;
      const angle = seed * TWO_PI + Math.sin(index * 0.73) * 0.4;
      x = Math.cos(angle) * (58 + seed * 126) * impulse + normalX * Math.sin(t * Math.PI * 5 + index) * 22 * envelope;
      y = Math.sin(angle) * (58 + seed * 126) * impulse - 38 * impulse * impulse;
      break;
    }
    case "scale-current": {
      const direction = index % 2 ? -1 : 1;
      const stream = Math.sin(t * TWO_PI * 2.2 + index * 0.19) * (38 + seed * 70);
      const scaleArc = Math.sin(t * Math.PI + (index % 9) * 0.34) * (56 + seed * 48);
      x = normalX * stream * envelope + dx / length * scaleArc * envelope;
      y = normalY * stream * envelope + dy / length * scaleArc * envelope + direction * 14 * envelope;
      break;
    }
    case "magnetic-shards": {
      const direction = index % 2 ? -1 : 1;
      const angle = direction * t * TWO_PI * (0.5 + seed * 0.55);
      const orbit = (38 + seed * 76) * envelope;
      x = Math.cos(angle) * orbit + normalX * 22 * envelope;
      y = Math.sin(angle) * orbit + normalY * 22 * envelope;
      break;
    }
    case "calligraphic-shards": {
      const sweep = Math.sin(t * Math.PI + seed * 1.7) * (52 + seed * 84) * envelope;
      const brushLift = Math.sin(t * TWO_PI * 2 + index * 0.23) * 26 * envelope;
      x = normalX * sweep + dx / length * brushLift;
      y = normalY * sweep + dy / length * brushLift;
      break;
    }
    case "dragon-draft": {
      const orbit = t * TWO_PI * (1.1 + seed * 0.8) + index * 0.071;
      const radius = (48 + seed * 122) * envelope;
      const gust = smoother(clamp(t * 1.8 - hash(index * 0.21) * 0.62)) * width * 0.11 * envelope;
      x = Math.cos(orbit) * radius + gust;
      y = Math.sin(orbit) * radius * 0.68 + Math.sin(t * 11 + index * 0.13) * 24 * envelope;
      break;
    }
    case "cursive-ash": {
      const ash = (70 + seed * 170) * envelope;
      const sway = Math.sin(t * TWO_PI * (1.6 + seed) + index * 0.29) * (42 + seed * 64);
      x = normalX * sway * envelope + dx / length * 28 * envelope;
      y = -ash + normalY * sway * envelope;
      break;
    }
    case "laminar-loong": {
      const lane = (index % 11) - 5;
      const ribbon = Math.sin(t * TWO_PI * 1.7 + lane * 0.52 + index * 0.03) * (34 + Math.abs(lane) * 7);
      x = normalX * ribbon * envelope + dx / length * lane * 8 * envelope;
      y = normalY * ribbon * envelope + dy / length * lane * 8 * envelope;
      break;
    }
    case "brushwake": {
      const s = clamp(t * 1.38 - (index % 19) / 19 * 0.38);
      const brush = Math.sin(s * Math.PI) * (74 + seed * 110);
      const bristle = Math.sin(s * TWO_PI * 3 + index * 0.27) * 22;
      x = (normalX * brush + dx / length * bristle) * envelope;
      y = (normalY * brush + dy / length * bristle) * envelope;
      break;
    }
    case "typhoon-typeset": {
      const spiral = (1 - Math.abs(t - 0.5) * 0.9) * (72 + seed * 150) * envelope;
      const angle = t * TWO_PI * (1.7 + seed) + index * 0.083;
      x = Math.cos(angle) * spiral + width * 0.08 * Math.sin(t * Math.PI) * envelope;
      y = Math.sin(angle) * spiral * 0.7;
      break;
    }
    case "dual-attractor": {
      const sign = index % 2 ? -1 : 1;
      const phase = t * TWO_PI * (1.2 + seed * 0.55) + sign * index * 0.09;
      const orbit = (54 + seed * 108) * envelope;
      x = Math.cos(phase) * orbit + sign * width * 0.085 * envelope * (1 - t);
      y = Math.sin(phase) * orbit * 0.72 + sign * 22 * envelope;
      break;
    }
    case "echo-shards": {
      const angle = seed * TWO_PI;
      const pulse = (0.72 + 0.28 * Math.sin(t * Math.PI * 7 + index * 0.31)) * envelope;
      x = Math.cos(angle) * (64 + seed * 112) * pulse + normalX * 18 * envelope;
      y = Math.sin(angle) * (64 + seed * 112) * pulse + normalY * 18 * envelope;
      break;
    }
    case "stroke-loong": {
      const branch = Math.sin(t * Math.PI * (2 + index % 4)) * (18 + seed * 32);
      x = normalX * branch * envelope;
      y = normalY * branch * envelope;
      break;
    }
    case "fluid-ink": {
      const orbit = (45 + seed * 95) * envelope;
      const angle = t * TWO_PI * (index % 2 ? 1 : -1) * (0.6 + seed);
      x = Math.cos(angle) * orbit;
      y = Math.sin(angle) * orbit;
      break;
    }
    case "morphogen": {
      const centerX = width / 2;
      const centerY = height / 2;
      const radialX = from.x - centerX;
      const radialY = from.y - centerY;
      const radialLength = Math.max(1, Math.hypot(radialX, radialY));
      const bloom = (20 + (index % 9) * 7) * envelope;
      x = radialX / radialLength * bloom;
      y = radialY / radialLength * bloom;
      break;
    }
    case "page-fault": {
      const direction = Math.floor(from.y / 18) % 2 ? 1 : -1;
      x = direction * (44 + seed * 90) * envelope;
      y = Math.sin(t * Math.PI * 8 + index) * 5 * envelope;
      break;
    }
    case "quadtree-fold": {
      const route = index % 4;
      const step = (54 + seed * 112) * envelope;
      const fold = Math.sin(t * Math.PI * (2 + index % 3)) * (18 + seed * 34) * envelope;
      x = (route === 0 ? -1 : route === 2 ? 1 : 0) * step + normalX * fold;
      y = (route === 1 ? -1 : route === 3 ? 1 : 0) * step + normalY * fold;
      break;
    }
    case "standing-wave": {
      const amplitude = (24 + seed * 70) * Math.sin((from.x / Math.max(1, width)) * Math.PI * 5);
      y = amplitude * Math.sin(t * TWO_PI * 2 + index * 0.07) * envelope;
      x = Math.sin(t * Math.PI + index) * 7 * envelope;
      break;
    }
    case "moire-wave": {
      const direction = index % 2 ? -1 : 1;
      x = direction * Math.sin(t * TWO_PI * 2.5 + index * 0.11) * (32 + seed * 50) * envelope;
      y = Math.sin(t * TWO_PI * 1.5 - index * 0.17) * (18 + seed * 30) * envelope;
      break;
    }
    case "soliton-wave": {
      const phase = (index % 19) / 18;
      const packet = Math.exp(-(((phase - t) / 0.16) ** 2)) * envelope;
      x = normalX * (72 + seed * 58) * packet;
      y = normalY * (72 + seed * 58) * packet;
      break;
    }
    case "seismic-wave": {
      const aftershock = Math.sin(t * Math.PI * 14 - index * 0.26) * Math.exp(-t * 1.4) * envelope;
      x = (index % 2 ? -1 : 1) * (40 + seed * 72) * aftershock;
      y = Math.cos(t * Math.PI * 9 + index) * 18 * envelope;
      break;
    }
    case "interference-wave": {
      const waveA = Math.sin(t * TWO_PI * 2 + index * 0.19);
      const waveB = Math.sin(t * TWO_PI * 3 - index * 0.13);
      x = normalX * (waveA + waveB) * (24 + seed * 36) * envelope;
      y = normalY * (waveA - waveB) * (24 + seed * 36) * envelope;
      break;
    }
    case "cellular": {
      const generation = Math.floor(t * 12);
      x = ((generation + index) % 3 - 1) * 12 * envelope;
      y = ((generation * 2 + index) % 3 - 1) * 12 * envelope;
      break;
    }
    case "woven": {
      const warp = index % 2 === 0;
      x = warp ? 0 : normalX * (34 + seed * 68) * envelope;
      y = warp ? normalY * (34 + seed * 68) * envelope : 0;
      break;
    }
  }
  return { x, y, scale, rotation };
}

function hermite(start, velocity, end, t, duration) {
  const tt = t * t;
  const ttt = tt * t;
  const h00 = 2 * ttt - 3 * tt + 1;
  const h10 = ttt - 2 * tt + t;
  const h01 = -2 * ttt + 3 * tt;
  return h00 * start + h10 * velocity * duration + h01 * end;
}

function tokenPose(token, progress, index, study, width, height) {
  const mid = token.midpoint;
  const handoff = token.handoff;
  const source = handoff || token.sourceCenter;
  const target = token.targetCenter;
  const midpointArrival = 0.44;
  const midpointDeparture = MIDPOINT_PROGRESS;
  const targetHold = 0.94;
  let from;
  let to;
  let t;
  let leg;
  if (progress < midpointArrival) {
    from = source;
    to = mid;
    leg = clamp(progress / midpointArrival);
    t = leg;
    const duration = study.durationMs * 0.96;
    const offset = trajectoryOffset(
      study.mode,
      t,
      index,
      token.seed,
      from,
      to,
      width,
      height,
      token.midpointRole,
    );
    const x = hermite(from.x, handoff?.vx || 0, to.x, t, duration) + offset.x;
    const y = hermite(from.y, handoff?.vy || 0, to.y, t, duration) + offset.y;
    const rotation = hermite(
      handoff?.rotation || 0,
      handoff?.angularVelocity || 0,
      0,
      t,
      duration,
    ) + offset.rotation;
    return { x, y, rotation, scale: 1 + offset.scale };
  } else if (progress <= midpointDeparture) {
    return { x: mid.x, y: mid.y, rotation: 0, scale: 1 };
  } else if (progress < targetHold) {
    from = mid;
    to = target;
    leg = clamp((progress - midpointDeparture) / (targetHold - midpointDeparture));
    t = smoother(leg);
  } else {
    return { x: target.x, y: target.y, rotation: 0, scale: 1 };
  }
  const offset = trajectoryOffset(
    study.mode,
    t,
    index,
    token.seed,
    from,
    to,
    width,
    height,
    token.midpointRole,
  );
  const x = from.x + (to.x - from.x) * t + offset.x;
  const y = from.y + (to.y - from.y) * t + offset.y;
  const motionEnvelope = Math.sin(Math.PI * t) ** 2;
  const rotationScale = ROTATING_TRANSITION_MODES.has(study.mode)
    ? (["shard-glass", "fracture-cascade"].includes(study.mode) ? 2.8 : 0.48)
    : 0;
  return {
    x,
    y,
    rotation: (token.seed - 0.5) * rotationScale * motionEnvelope + offset.rotation,
    scale: 1 + offset.scale,
  };
}

function drawAtlasPiece(context, atlas, piece, pose, dpr, alpha, colorOverride = null) {
  if (!piece || alpha <= 0.002) return;
  if (piece.particle) {
    const particleScale = Math.max(0.12, pose.scale || 1);
    context.globalAlpha = alpha;
    context.fillStyle = colorOverride || piece.color || "#000";
    context.fillRect(
      pose.x - piece.width * particleScale / 2,
      pose.y - piece.height * particleScale / 2,
      piece.width * particleScale,
      piece.height * particleScale,
    );
    context.globalAlpha = 1;
    return;
  }
  const sourceX = Math.max(0, piece.x * dpr);
  const sourceY = Math.max(0, piece.y * dpr);
  const sourceWidth = Math.max(1, piece.width * dpr);
  const sourceHeight = Math.max(1, piece.height * dpr);
  if (!piece.polygon && Math.abs(pose.rotation) < 0.0001 && Math.abs(pose.scale - 1) < 0.0001) {
    context.globalAlpha = alpha;
    context.drawImage(
      atlas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      pose.x - piece.width / 2,
      pose.y - piece.height / 2,
      piece.width,
      piece.height,
    );
    context.globalAlpha = 1;
    return;
  }
  context.save();
  context.globalAlpha = alpha;
  context.translate(pose.x, pose.y);
  context.rotate(pose.rotation);
  context.scale(pose.scale, pose.scale);
  if (piece.polygon) {
    context.beginPath();
    piece.polygon.forEach(([x, y], index) => {
      const pointX = (x - 0.5) * piece.width;
      const pointY = (y - 0.5) * piece.height;
      if (!index) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.closePath();
    context.clip();
  }
  context.drawImage(
    atlas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    -piece.width / 2,
    -piece.height / 2,
    piece.width,
    piece.height,
  );
  context.restore();
}

function drawGlobalField(context, scene, progress, now) {
  const { width, height, study } = scene;
  const field = Math.sin(Math.PI * clamp(progress)) ** 2;
  if (field < 0.01) return;
  context.save();
  context.strokeStyle = "#111";
  context.fillStyle = "#111";
  context.lineWidth = 0.7;
  context.globalAlpha = field * 0.12;
  switch (study.mode) {
    case "sigil-eye": {
      // Study 01 now has two pure loong attractors. Its moving fragments are
      // the field; a fixed eye diagram would reintroduce the discarded hybrid.
      break;
    }
    case "pearl-current": {
      const pearlX = width * 0.12;
      const pearlY = height * 0.56;
      for (let stream = 0; stream < 9; stream += 1) {
        context.beginPath();
        const radius = 26 + stream * 12;
        for (let step = 0; step <= 54; step += 1) {
          const angle = step / 54 * TWO_PI + now * 0.00014 * (stream % 2 ? -1 : 1);
          const x = pearlX + Math.cos(angle) * radius * (1 + stream * 0.025);
          const y = pearlY + Math.sin(angle) * radius * 0.68;
          if (!step) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      break;
    }
    case "ink-depth": {
      context.strokeStyle = "#6f665d";
      for (let strip = 0; strip < 12; strip += 1) {
        const baseY = height * (strip + 1) / 13;
        context.beginPath();
        for (let step = 0; step <= 48; step += 1) {
          const x = step / 48 * width;
          const depth = Math.sin(step / 48 * Math.PI * 2 + strip * 0.54 + now * 0.0007);
          const y = baseY + depth * (4 + strip % 3 * 2) * field;
          if (!step) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      break;
    }
    case "negative-field": {
      for (let ring = 0; ring < 17; ring += 1) {
        const radius = Math.min(width, height) * (0.05 + ring * 0.025);
        context.beginPath();
        for (let step = 0; step <= 72; step += 1) {
          const angle = step / 72 * TWO_PI;
          const reaction = Math.sin(angle * (3 + ring % 4) + now * 0.0013 + ring) * 8 * field;
          const x = width / 2 + Math.cos(angle) * (radius + reaction);
          const y = height / 2 + Math.sin(angle) * (radius * 0.7 + reaction);
          if (!step) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      break;
    }
    case "dragon-bone": {
      context.strokeStyle = "#766b61";
      for (let mark = 0; mark < 9; mark += 1) {
        const inset = 18 + mark * 6;
        const length = 8 + (mark % 3) * 5;
        context.beginPath();
        context.moveTo(inset, inset + length);
        context.lineTo(inset, inset);
        context.lineTo(inset + length, inset);
        context.moveTo(width - inset, height - inset - length);
        context.lineTo(width - inset, height - inset);
        context.lineTo(width - inset - length, height - inset);
        context.stroke();
      }
      break;
    }
    case "latent-diffusion": {
      for (let index = 0; index < 90; index += 1) {
        const x = hash(index * 7.3 + now * 0.00004) * width;
        const y = hash(index * 13.7 - now * 0.00003) * height;
        context.fillRect(x, y, 0.7, 0.7);
      }
      break;
    }
    case "shard-glass": {
      for (let crack = 0; crack < 11; crack += 1) {
        context.beginPath();
        context.moveTo(width / 2, height / 2);
        for (let joint = 1; joint <= 5; joint += 1) {
          const angle = crack / 11 * TWO_PI + (hash(crack * 19 + joint) - 0.5) * 0.42;
          const radius = joint / 5 * Math.max(width, height) * 0.62;
          context.lineTo(width / 2 + Math.cos(angle) * radius, height / 2 + Math.sin(angle) * radius);
        }
        context.stroke();
      }
      break;
    }
    case "stroke-loong": {
      context.globalAlpha = field * 0.16;
      for (let branch = 0; branch < 18; branch += 1) {
        const startX = width * (0.1 + hash(branch * 5.2) * 0.8);
        const startY = height * (0.18 + hash(branch * 7.1) * 0.64);
        context.beginPath();
        context.moveTo(startX, startY);
        for (let joint = 1; joint <= 5; joint += 1) {
          context.lineTo(
            startX + (hash(branch * 31 + joint * 9) - 0.5) * joint * 16 * field,
            startY + (hash(branch * 17 + joint * 13) - 0.5) * joint * 16 * field,
          );
        }
        context.stroke();
      }
      break;
    }
    case "fluid-ink": {
      for (const [cx, direction] of [[0.34, 1], [0.66, -1]]) {
        context.beginPath();
        for (let step = 0; step < 110; step += 1) {
          const angle = direction * step * 0.12 + now * 0.0004;
          const radius = (1 - step / 110) * Math.min(width, height) * 0.22;
          const x = width * cx + Math.cos(angle) * radius;
          const y = height * 0.5 + Math.sin(angle) * radius;
          if (!step) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      break;
    }
    case "morphogen": {
      for (let spot = 0; spot < 56; spot += 1) {
        const angle = spot * 2.399963;
        const radius = Math.sqrt((spot + 1) / 56);
        const x = width / 2 + Math.cos(angle) * radius * width * 0.42;
        const y = height / 2 + Math.sin(angle) * radius * height * 0.38;
        context.beginPath();
        context.arc(x, y, 1 + (spot % 5) * 1.3 * field, 0, TWO_PI);
        context.stroke();
      }
      break;
    }
    case "page-fault": {
      for (let band = 0; band < 9; band += 1) {
        context.beginPath();
        for (let joint = 0; joint <= 18; joint += 1) {
          const x = joint / 18 * width;
          const y = height * (band + 1) / 10 + (hash(band * 71 + joint * 13) - 0.5) * 22 * field;
          if (!joint) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      break;
    }
    case "quadtree-fold": {
      for (let depth = 0; depth < 5; depth += 1) {
        const divisions = 2 ** depth;
        const size = Math.min(width, height) * 0.5 / divisions;
        for (let index = 0; index < divisions; index += 1) {
          context.strokeRect(
            width / 2 - size * divisions / 2 + index * size,
            height / 2 - size * divisions / 2 + ((index * 3) % divisions) * size,
            size,
            size,
          );
        }
      }
      break;
    }
    case "standing-wave": {
      for (let band = 0; band < 11; band += 1) {
        context.beginPath();
        for (let step = 0; step <= 100; step += 1) {
          const x = step / 100 * width;
          const y = height * (band + 1) / 12 + Math.sin(step / 100 * TWO_PI * (2 + band % 3) + now * 0.002) * 16 * field;
          if (!step) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      break;
    }
    case "cellular": {
      const size = Math.max(12, Math.min(width, height) / 38);
      for (let row = 0; row < Math.ceil(height / size); row += 1) {
        for (let column = 0; column < Math.ceil(width / size); column += 1) {
          const generation = Math.floor(now / 130);
          const neighbors = [
            hash((row - 1) * 71 + column * 37 + generation),
            hash((row + 1) * 71 + column * 37 + generation),
            hash(row * 71 + (column - 1) * 37 + generation),
            hash(row * 71 + (column + 1) * 37 + generation),
          ].filter((value) => value > 0.55).length;
          if (neighbors === 2 || neighbors === 3) context.fillRect(column * size, row * size, 1.2, 1.2);
        }
      }
      break;
    }
    case "woven": {
      for (let column = 1; column < 30; column += 1) {
        const x = column / 30 * width;
        context.beginPath();
        context.moveTo(x, 0);
        context.bezierCurveTo(x + 12 * field, height * 0.33, x - 12 * field, height * 0.66, x, height);
        context.stroke();
      }
      for (let row = 1; row < 20; row += 1) {
        const y = row / 20 * height;
        context.beginPath();
        context.moveTo(0, y);
        context.bezierCurveTo(width * 0.33, y + 8 * field, width * 0.66, y - 8 * field, width, y);
        context.stroke();
      }
      break;
    }
  }
  context.restore();
}

function midpointEffectOffset(effect, now, mode) {
  const level = smoother(effect.level);
  const pulse = Math.sin(now * 0.003 + effect.phase * TWO_PI);
  switch (mode) {
    case "sigil-eye": {
      const calligraphy = effect.motif === "calligraphy";
      const orbit = calligraphy ? 68 : 42;
      // B6 — the displacement direction rotates over the life of the effect
      // rather than oscillating in place, so a hand pushed through the body
      // leaves a curl behind it that unwinds as the fragments return. The
      // handedness is fixed per fragment, which reads as a coherent eddy
      // instead of a shimmer.
      const curl = (effect.curlSign || 1) * level * 1.35
        + (now - (effect.createdAt || now)) * 0.00042 * (effect.curlSign || 1);
      const cos = Math.cos(curl);
      const sin = Math.sin(curl);
      const directionX = effect.directionX * cos - effect.directionY * sin;
      const directionY = effect.directionX * sin + effect.directionY * cos;
      return {
        x: (directionX * 26 + directionY * pulse * orbit) * level,
        y: (directionY * 26 - directionX * pulse * orbit) * level,
        rotation: pulse * (calligraphy ? 0.34 : 0.14) * level,
        scale: calligraphy ? 0.24 * level : 0,
      };
    }
    case "pearl-current": {
      const calligraphy = effect.motif === "calligraphy";
      return {
        x: (effect.directionX * (calligraphy ? 92 : 52) + effect.directionY * pulse * 34) * level,
        y: (effect.directionY * (calligraphy ? 92 : 52) - effect.directionX * pulse * 34) * level,
        rotation: 0,
        scale: calligraphy ? 0.1 * level : 0,
      };
    }
    case "ink-depth": {
      const depth = effect.seed * 2 - 1;
      return {
        x: (effect.directionX * 34 + depth * pulse * 46) * level,
        y: (effect.directionY * 34 - depth * 48) * level,
        rotation: depth * pulse * 0.12 * level,
        scale: depth * 0.1 * level,
      };
    }
    case "negative-field": {
      const pressure = 82 + effect.seed * 68;
      return {
        x: (effect.directionX * pressure + effect.directionY * pulse * 22) * level,
        y: (effect.directionY * pressure - effect.directionX * pulse * 22) * level,
        rotation: 0,
        scale: 0,
      };
    }
    case "dragon-bone": {
      const calligraphy = effect.motif === "calligraphy";
      const wave = Math.sin(now * 0.0041 - effect.index * 0.17 + effect.phase * TWO_PI);
      return {
        x: (effect.directionX * 36 + effect.directionY * wave * (calligraphy ? 78 : 54)) * level,
        y: (effect.directionY * 36 - effect.directionX * wave * (calligraphy ? 78 : 54)) * level,
        rotation: wave * 0.22 * level,
        scale: calligraphy ? 0.08 * level : 0,
      };
    }
    case "powder-wind":
      return {
        x: (effect.directionX * (72 + effect.seed * 54) + effect.directionY * pulse * 28) * level,
        y: (effect.directionY * (72 + effect.seed * 54) - effect.directionX * pulse * 28) * level,
        rotation: 0,
      };
    case "latent-diffusion":
      return {
        x: (effect.directionX * 54 + effect.directionY * pulse * 15) * level,
        y: (effect.directionY * 54 - effect.directionX * pulse * 15) * level,
        rotation: 0,
      };
    case "shard-glass":
      return {
        x: effect.directionX * (54 + effect.seed * 38) * level,
        y: effect.directionY * (54 + effect.seed * 38) * level - 18 * level * level,
        rotation: (effect.seed - 0.5) * 1.25 * level,
      };
    case "fracture-cascade": {
      const front = smoother(clamp(level * 1.4 - (effect.index % 13) / 13 * 0.28));
      return {
        x: effect.directionX * (62 + effect.seed * 42) * front,
        y: effect.directionY * (62 + effect.seed * 42) * front - 16 * front * front,
        rotation: (effect.seed - 0.5) * 1.05 * front,
      };
    }
    case "scale-current":
      return {
        x: (effect.directionX * 38 + effect.directionY * pulse * 64) * level,
        y: (effect.directionY * 38 - effect.directionX * pulse * 64) * level,
        rotation: pulse * 0.28 * level,
      };
    case "magnetic-shards": {
      const direction = effect.index % 2 ? -1 : 1;
      return {
        x: (effect.directionX * 24 + effect.directionY * direction * 58) * level,
        y: (effect.directionY * 24 - effect.directionX * direction * 58) * level,
        rotation: direction * 0.52 * level,
      };
    }
    case "calligraphic-shards":
      return {
        x: (effect.directionY * pulse * 54 + effect.directionX * 24) * level,
        y: (-effect.directionX * pulse * 54 + effect.directionY * 24) * level,
        rotation: pulse * 0.16 * level,
      };
    case "dragon-draft": {
      const angle = now * 0.0024 + effect.phase * TWO_PI;
      return {
        x: (effect.directionX * 44 + Math.cos(angle) * (42 + effect.seed * 34)) * level,
        y: (effect.directionY * 44 + Math.sin(angle) * (34 + effect.seed * 28)) * level,
        rotation: 0,
      };
    }
    case "cursive-ash":
      return {
        x: (effect.directionX * 48 + pulse * 36) * level,
        y: (effect.directionY * 42 - 74 - effect.seed * 36) * level,
        rotation: 0,
      };
    case "laminar-loong":
      return {
        x: (effect.directionX * 34 + effect.directionY * pulse * 72) * level,
        y: (effect.directionY * 34 - effect.directionX * pulse * 72) * level,
        rotation: pulse * 0.08 * level,
      };
    case "brushwake":
      return {
        x: (effect.directionX * 36 + effect.directionY * pulse * 82) * level,
        y: (effect.directionY * 36 - effect.directionX * pulse * 82) * level,
        rotation: pulse * 0.22 * level,
      };
    case "typhoon-typeset": {
      const angle = now * 0.003 + effect.phase * TWO_PI;
      return {
        x: (effect.directionX * 28 + Math.cos(angle) * (68 + effect.seed * 44)) * level,
        y: (effect.directionY * 28 + Math.sin(angle) * (68 + effect.seed * 44)) * level,
        rotation: 0,
      };
    }
    case "dual-attractor": {
      const sign = effect.index % 2 ? -1 : 1;
      return {
        x: (effect.directionX * 30 + sign * 56 + pulse * 24) * level,
        y: (effect.directionY * 30 + sign * pulse * 62) * level,
        rotation: sign * pulse * 0.3 * level,
      };
    }
    case "echo-shards":
      return {
        x: effect.directionX * (48 + pulse * 18) * level,
        y: effect.directionY * (48 + pulse * 18) * level,
        rotation: (effect.seed - 0.5) * 0.48 * level,
      };
    case "fluid-ink":
      return {
        x: (effect.directionY * 58 + effect.directionX * 18) * level,
        y: (-effect.directionX * 58 + effect.directionY * 18) * level,
        rotation: (effect.seed - 0.5) * 0.4 * level,
      };
    case "quadtree-fold": {
      const axis = effect.index % 4;
      return {
        x: (axis === 0 ? -1 : axis === 2 ? 1 : 0) * (52 + effect.seed * 26) * level,
        y: (axis === 1 ? -1 : axis === 3 ? 1 : 0) * (52 + effect.seed * 26) * level,
        rotation: (effect.seed - 0.5) * 0.32 * level,
      };
    }
    case "standing-wave":
      return {
        x: pulse * (42 + effect.seed * 24) * level,
        y: effect.directionY * 10 * level,
        rotation: pulse * 0.035 * level,
      };
    case "moire-wave": {
      const direction = effect.index % 2 ? -1 : 1;
      return {
        x: direction * pulse * (52 + effect.seed * 26) * level,
        y: Math.cos(now * 0.0023 + effect.phase * TWO_PI) * 16 * level,
        rotation: direction * pulse * 0.045 * level,
      };
    }
    case "soliton-wave": {
      const travel = (now * 0.00042 + effect.phase) % 1;
      const position = (effect.index % 23) / 22;
      const packet = Math.exp(-(((position - travel) / 0.15) ** 2));
      return {
        x: effect.directionX * (30 + 62 * packet) * level,
        y: effect.directionY * (30 + 62 * packet) * level,
        rotation: (packet - 0.5) * 0.08 * level,
      };
    }
    case "seismic-wave": {
      const cycle = (now * 0.0011 + effect.phase) % 1;
      const quake = Math.sin(cycle * Math.PI * 12) * Math.exp(-cycle * 3.2);
      return {
        x: quake * (72 + effect.seed * 32) * level,
        y: Math.cos(cycle * Math.PI * 8) * 12 * level,
        rotation: quake * 0.09 * level,
      };
    }
    case "interference-wave": {
      const second = Math.sin(now * 0.0047 - effect.phase * TWO_PI);
      return {
        x: (pulse + second) * 34 * level,
        y: (pulse - second) * 34 * level,
        rotation: (pulse + second) * 0.045 * level,
      };
    }
    default:
      return { x: effect.directionX * 50 * level, y: effect.directionY * 50 * level, rotation: 0 };
  }
}

function preparePassiveMidpoint(tokens, bounds) {
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  for (const token of tokens) {
    const u = clamp((token.midpoint.x - bounds.left) / Math.max(1, bounds.width));
    const v = clamp((token.midpoint.y - bounds.top) / Math.max(1, bounds.height));
    token.passiveMidpoint = {
      u,
      v,
      silhouette: Math.sin(Math.PI * u) ** 0.68,
      head: smoother(clamp((u - 0.58) / 0.36)),
      // How strongly this fragment answers the pointer. The head leads, and a
      // reduced share of the same pull travels back along the body.
      lead: smoother(clamp((u - 0.34) / 0.5)),
      dx: token.midpoint.x - centerX,
      dy: token.midpoint.y - centerY,
    };
  }
}

function passiveMidpointOffset(token, time, scene) {
  const { u, v, silhouette, head, lead, dx, dy } = token.passiveMidpoint;
  const swim = scene.swim;

  if (token.midpointRole !== "calligraphy") {
    // A spatially coherent wave travels from tail to head. Every fragment
    // moves, but nearby fragments share phase so the animal remains readable.
    const body = Math.sin(time * 1.42 - u * TWO_PI * 2.65 + v * 1.2);
    const counter = Math.sin(time * 0.71 + u * TWO_PI * 0.9 - v * 0.8);
    const micro = Math.sin(time * 2.08 + token.fieldPhase) * 0.28;
    // B6 — the whole animal drifts on two incommensurate periods, so it never
    // repeats a position exactly and never sits still enough to read as a
    // static image.
    const wanderX = Math.sin(time * 0.184) * SWIM_DRIFT_X
      + Math.sin(time * 0.317 + 2.1) * SWIM_DRIFT_X * 0.38;
    const wanderY = Math.cos(time * 0.143) * SWIM_DRIFT_Y
      + Math.cos(time * 0.263 + 1.3) * SWIM_DRIFT_Y * 0.42;
    // The head leans toward the pointer; the rest of the body inherits a
    // fraction of the same pull, delayed along its length, so the turn
    // propagates backward the way it would in water.
    const followPhase = Math.sin(time * 1.15 - u * TWO_PI * 1.4);
    const reach = lead + (1 - lead) * SWIM_BODY_FOLLOW * (0.62 + followPhase * 0.38);
    const seekX = (swim?.x || 0) * reach;
    const seekY = (swim?.y || 0) * reach;
    return {
      x: (Math.sin(time * 0.37) * 1.35 + counter * (0.55 + head * 1.05) + micro) 
        + wanderX + seekX,
      y: (Math.cos(time * 0.31) * 0.85 + body * (1.45 + silhouette * 3.55 + head * 0.9)) 
        + wanderY + seekY,
      rotation: 0,
      scale: 0,
    };
  }

  // Two incommensurate modes keep the calligraphy just off perfect rest. The
  // deformation is a slow breath and shear, not random particle jitter.
  const breath = Math.sin(time * 0.67) * 0.0048 + Math.sin(time * 1.03 + 0.8) * 0.0022;
  const shear = Math.sin(time * 0.49 + 1.2) * 0.0042;
  const strokeWave = Math.sin(time * 1.83 + u * 5.1 - v * 3.7 + token.fieldPhase * 0.08) * 0.3;
  // The calligraphy leans rather than swims: the brush drifts toward the
  // pointer as a whole instead of articulating a body.
  const leanX = (swim?.x || 0) * 0.34;
  const leanY = (swim?.y || 0) * 0.34;
  return {
    x: (dx * breath + dy * shear + strokeWave) + leanX,
    y: (-dy * breath * 0.55 + dx * shear * 0.22 - strokeWave * 0.42) + leanY,
    rotation: 0,
    scale: 0,
  };
}

// The pointer-seeking component of B6. Kept as scene state rather than
// recomputed per token: it eases toward the pointer once per frame and every
// fragment reads the same smoothed vector, which is what keeps the body
// coherent instead of letting each piece chase independently.
function advanceSwim(scene, pointer, origin, deltaSeconds) {
  if (!scene.swim) scene.swim = { x: 0, y: 0 };
  let targetX = 0;
  let targetY = 0;
  if (pointer && origin) {
    const dx = pointer.x - origin.x;
    const dy = pointer.y - origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.001) {
      // Saturating, not linear: a pointer on the far side of the screen pulls
      // the head no harder than one just outside the formation.
      const pull = SWIM_SEEK_RANGE * (1 - Math.exp(-distance / 260));
      targetX = (dx / distance) * pull;
      targetY = (dy / distance) * pull;
    }
  }
  const ease = 1 - Math.exp(-deltaSeconds / SWIM_SEEK_EASE);
  scene.swim.x += (targetX - scene.swim.x) * ease;
  scene.swim.y += (targetY - scene.swim.y) * ease;
}

function passiveMidpointEnvelope(progress) {
  const arrival = smoother(clamp((progress - 0.31) / 0.13));
  const departure = 1 - smoother(clamp((progress - MIDPOINT_PROGRESS) / 0.15));
  return arrival * departure;
}

function midpointVisualAnchor(
  scene,
  token,
  index,
  now,
  activeEffects = null,
  retiredEffects = null,
) {
  let x = token.midpoint.x;
  let y = token.midpoint.y;
  if (scene.passiveMidpointMotion && token.passiveMidpoint) {
    const passive = passiveMidpointOffset(token, now * 0.001, scene);
    const strength = passiveMidpointEnvelope(MIDPOINT_PROGRESS);
    x += passive.x * strength;
    y += passive.y * strength;
  }
  const effect = activeEffects?.get(index) || retiredEffects?.get(index);
  if (effect) {
    const offset = midpointEffectOffset(effect, now, scene.study.mode);
    x += offset.x;
    y += offset.y;
  }
  return { x, y };
}

function renderTransition(context, scene, progress, now = performance.now(), options = {}) {
  const {
    width,
    height,
    dpr,
    sourceAtlas,
    targetAtlas,
    sourceChromeAtlas,
    targetChromeAtlas,
    tokens,
    study,
  } = scene;
  context.clearRect(0, 0, width, height);
  context.fillStyle = PAPER;
  context.fillRect(0, 0, width, height);

  const poseProgress = progress;
  // The complete atlases bookend the capped sprite field. At progress zero the
  // source atlas is exact; hovered glyphs are cut out and replaced by every one
  // of their live local pieces. At the other end the exact target atlas takes
  // over completely. Between them, the capped sprites carry the same material
  // and trajectories without demanding tens of thousands of draws per frame.
  const sourcePageAlpha = 1 - smoother(clamp(progress / 0.12));
  const baseFragmentReveal = smoother(clamp(progress / 0.1));
  const exactTargetAlpha = smoother(clamp((poseProgress - 0.89) / 0.1));
  const targetFragmentFade = 1 - exactTargetAlpha;
  let sourceChromeAlpha = 1 - smoother(clamp(progress / 0.16));
  if (sourcePageAlpha > 0.002) {
    context.globalAlpha = sourcePageAlpha;
    context.drawImage(sourceAtlas, 0, 0, width, height);
    context.globalAlpha = 1;
    context.fillStyle = PAPER;
    for (const rect of scene.handoffRects || []) {
      const mix = handoffFragmentMix(rect.fragmentMix ?? 1, progress);
      if (rect.kind === "image-tile") {
        drawImageTileMask(context, rect, mix);
      } else {
        context.globalAlpha = mix;
        context.fillRect(rect.left, rect.top, rect.width, rect.height);
      }
    }
    context.globalAlpha = 1;
    sourceChromeAlpha *= 1 - sourcePageAlpha;
  }
  // `rasterLayer` already contains the structural chrome. Fade the separate
  // chrome atlas away as the exact target takes over so progress 1 is one
  // unmodified target atlas, not the same rules painted twice.
  const targetChromeAlpha = smoother(clamp((progress - 0.84) / 0.14))
    * (1 - exactTargetAlpha);
  if (sourceChromeAtlas && sourceChromeAlpha > 0.002) {
    context.globalAlpha = sourceChromeAlpha;
    context.drawImage(sourceChromeAtlas, 0, 0, width, height);
  }
  if (targetChromeAtlas && targetChromeAlpha > 0.002) {
    context.globalAlpha = targetChromeAlpha;
    context.drawImage(targetChromeAtlas, 0, 0, width, height);
  }
  context.globalAlpha = 1;
  drawGlobalField(context, scene, progress, now);

  // Texture changes only while the fragments are holding the 龍 formation.
  // At every point, the visible units remain clipped pieces of real letters.
  const targetTexture = smoother(clamp((poseProgress - 0.48) / 0.08));
  const sourceTexture = 1 - targetTexture;
  const negativeHeartStrength = study.mode === "negative-field"
    ? smoother(clamp((poseProgress - 0.3) / 0.13))
      * (1 - smoother(clamp((poseProgress - MIDPOINT_PROGRESS) / 0.18)))
    : 0;
  const negativeHeartPieces = [];
  const flash = clamp(options.flash || 0);
  // How fully the fragments are holding the formation. The wash is tied to it
  // so the loong only falls back while the shape actually exists — on the way
  // in and out these are page fragments and must not be dimmed.
  const formStrength = passiveMidpointEnvelope(poseProgress);
  const passiveStrength = scene.passiveMidpointMotion && options.allowPassive !== false
    ? passiveMidpointEnvelope(poseProgress)
    : 0;
  const passiveTime = now * 0.001;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const pose = tokenPose(token, poseProgress, index, study, width, height);
    if (
      scene.rotatingTokenStride > 1
      && index % scene.rotatingTokenStride !== 0
    ) {
      // Mobile keeps one tumbling fragment in every stride. Handoff pieces
      // retain their live rotation at the start, then settle into the cheap
      // non-rotated draw path without a visible snap.
      const handoffRotation = token.handoff
        ? 1 - smoother(clamp(poseProgress / 0.15))
        : 0;
      pose.rotation *= handoffRotation;
    }
    if (passiveStrength > 0.001) {
      const passive = passiveMidpointOffset(token, passiveTime, scene);
      pose.x += passive.x * passiveStrength;
      pose.y += passive.y * passiveStrength;
    }
    const midpointEffect = options.midpointEffects?.get(index)
      || options.retiredMidpointEffects?.get(index);
    if (midpointEffect && options.offsetScale > 0) {
      const offset = midpointEffectOffset(midpointEffect, now, study.mode);
      pose.x += offset.x * options.offsetScale;
      pose.y += offset.y * options.offsetScale;
      pose.rotation += offset.rotation * options.offsetScale;
      pose.scale += (offset.scale || 0) * options.offsetScale;
    }
    const enter = token.source ? 1 : smoother(clamp(poseProgress / 0.26));
    const leave = token.target ? 1 : 1 - smoother(clamp((poseProgress - 0.66) / 0.26));
    const baselineReveal = PARTICLE_MODES.has(study.mode) && !token.handoff
      ? 1 - sourcePageAlpha
      : 1;
    const wash = !scene.hasCalligraphy || token.midpointRole === "calligraphy"
      ? 1
      : 1 - MIDPOINT_WASH * formStrength;
    const endpointReveal = token.handoff
      ? handoffFragmentMix(token.handoff.fragmentMix ?? 1, poseProgress)
      : baseFragmentReveal;
    const existence = enter * leave * baselineReveal * wash
      * endpointReveal * targetFragmentFade;
    if (study.mode === "ink-depth" && token.handoff && sourceTexture > 0.002) {
      const shadowLife = 1 - smoother(clamp(poseProgress / 0.13));
      const shadowLevel = smoother(token.handoff.level || 0);
      drawAtlasPiece(
        context,
        sourceAtlas,
        token.sourceInk,
        { ...pose, x: pose.x + 3.5 * shadowLevel, y: pose.y + 5.5 * shadowLevel },
        dpr,
        sourceTexture * existence * shadowLife * shadowLevel * 0.11,
      );
    }
    drawAtlasPiece(context, sourceAtlas, token.sourceInk, pose, dpr, sourceTexture * existence);
    drawAtlasPiece(context, targetAtlas, token.targetInk, pose, dpr, targetTexture * existence);
    if (negativeHeartStrength > 0.002 && token.midpointRole === "calligraphy") {
      negativeHeartPieces.push({ token, pose: { ...pose, scale: (pose.scale || 1) * 2.25 }, existence });
    }
  }
  // In Negative-Field Loong the cursive 龍 is literally an absence. Rendering
  // its tagged particle layer last in paper white cuts the historical mask out
  // of the dragon body instead of accidentally adding another black glyph.
  for (const { token, pose, existence } of negativeHeartPieces) {
    drawAtlasPiece(
      context,
      sourceAtlas,
      token.sourceInk,
      pose,
      dpr,
      negativeHeartStrength * sourceTexture * existence,
      PAPER,
    );
    drawAtlasPiece(
      context,
      targetAtlas,
      token.targetInk,
      pose,
      dpr,
      negativeHeartStrength * targetTexture * existence,
      PAPER,
    );
  }
  // E19 — cinnabar, once.
  //
  // A flat `lighten` fill over the whole frame is the entire effect. Every
  // channel of the paper is already brighter than the corresponding channel of
  // cinnabar, so paper comes through untouched, while the ink — which is
  // darker in every channel — is lifted exactly to the pigment. Redrawing the
  // fragments in colour would not work: the posed modes blit clipped rectangles
  // out of the glyph atlas, and drawImage has no tint.
  if (flash > 0.002) {
    context.save();
    context.globalCompositeOperation = "lighten";
    context.globalAlpha = flash;
    context.fillStyle = `rgb(${CINNABAR_RGB[0]}, ${CINNABAR_RGB[1]}, ${CINNABAR_RGB[2]})`;
    context.fillRect(0, 0, width, height);
    context.restore();
  }
  if (exactTargetAlpha > 0.002) {
    context.globalAlpha = exactTargetAlpha;
    context.drawImage(targetAtlas, 0, 0, width, height);
  }
  context.globalAlpha = 1;
}

function sampleGlyphInk(glyph, count = 64, shapeCache = null) {
  const shapeKey = `${glyph.character}|${glyph.font}|${glyph.rect.width.toFixed(1)}|${glyph.rect.height.toFixed(1)}|${(glyph.baseline - glyph.rect.top).toFixed(1)}`;
  let candidates = shapeCache?.get(shapeKey);
  if (!candidates) {
    const scale = 2;
    const pad = 5;
    const width = Math.max(10, Math.ceil(glyph.rect.width + pad * 2));
    const height = Math.max(10, Math.ceil(glyph.rect.height + pad * 2));
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.scale(scale, scale);
    context.font = glyph.font;
    context.fillStyle = "#000";
    context.textBaseline = "alphabetic";
    context.fillText(glyph.character, pad, glyph.baseline - glyph.rect.top + pad);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    candidates = [];
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x < canvas.width; x += 2) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 60) {
          candidates.push({ x: x / scale - pad, y: y / scale - pad });
        }
      }
    }
    shapeCache?.set(shapeKey, candidates);
  }
  if (!candidates.length) return [];
  const seed = hashString(glyph.key);
  return Array.from({ length: count }, (_, index) => {
    // A golden-ratio sequence makes every prefix well distributed. Global
    // transition particles are therefore an exact subset of the denser local
    // hover particles, rather than a fresh resampling that would jump at handoff.
    const unit = (hash(seed * 3.17) + index * 0.618033988749895) % 1;
    const candidateIndex = Math.min(candidates.length - 1, Math.floor(unit * candidates.length));
    const point = candidates[candidateIndex];
    const angle = hash(seed + index * 11.3) * TWO_PI;
    const distance = 12 + hash(seed + index * 5.9) * 32;
    return {
      x: point.x,
      y: point.y,
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      phase: hash(seed + index * 17.9),
      size: 0.65 + hash(seed + index * 13.7) * 1.25,
    };
  });
}

function drawGlyphFragment(context, effect, fragment, dx, dy, rotation = 0, alpha = 1) {
  const glyph = effect.glyph;
  const centerX = fragment.x + fragment.width / 2;
  const centerY = fragment.y + fragment.height / 2;
  context.save();
  context.translate(centerX + dx, centerY + dy);
  context.rotate(rotation);
  context.translate(-centerX, -centerY);
  context.beginPath();
  if (fragment.polygon) {
    fragment.polygon.forEach(([x, y], index) => {
      const pointX = fragment.x + x * fragment.width;
      const pointY = fragment.y + y * fragment.height;
      if (!index) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.closePath();
  } else {
    context.rect(fragment.x, fragment.y, fragment.width, fragment.height);
  }
  context.clip();
  drawGlyph(context, glyph, alpha);
  context.restore();
}

export function wholeImageFragmentMix(amount) {
  return smoother(clamp(
    (amount - WHOLE_IMAGE_FRAGMENT_START) / WHOLE_IMAGE_FRAGMENT_SPAN,
  ));
}

function imageFragmentMix(effect) {
  return effect.glyph.kind === "image"
    ? wholeImageFragmentMix(effect.level)
    : 1;
}

function isTiledImageGlyph(glyph) {
  return glyph.kind === "image"
    && !glyph.wholeImage
    && glyph.imageGroupKey;
}

export function imageMaskGeometry(glyph) {
  const { rect } = glyph;
  return {
    kind: "image-tile",
    left: rect.left,
    top: rect.top,
    right: rect.right ?? rect.left + rect.width,
    bottom: rect.bottom ?? rect.top + rect.height,
    width: rect.width,
    height: rect.height,
  };
}

function drawImageTileMask(context, mask, alpha) {
  if (alpha <= 0.002) return;
  context.globalAlpha = clamp(alpha);
  context.fillStyle = PAPER;
  context.fillRect(mask.left, mask.top, mask.width, mask.height);
  context.globalAlpha = 1;
}

function visibleLocalEffects(active, hardLimit = LOCAL_EFFECT_HARD_LIMIT) {
  const liveImages = [];
  const retiredImages = [];
  for (const effect of active) {
    if (!isTiledImageGlyph(effect.glyph)) continue;
    if (effect.retiredAt) retiredImages.push(effect);
    else liveImages.push(effect);
  }
  const remaining = Math.max(0, hardLimit - liveImages.length);
  retiredImages.sort((left, right) => (
    right.level - left.level
    || (right.retiredAt || 0) - (left.retiredAt || 0)
  ));
  const admittedImages = new Set([
    ...liveImages,
    ...retiredImages.slice(0, remaining),
  ]);
  return active.filter((effect) => (
    !isTiledImageGlyph(effect.glyph) || admittedImages.has(effect)
  ));
}

export function handoffFragmentMix(initialMix, progress) {
  const start = clamp(initialMix);
  return start + (1 - start) * smoother(clamp(progress / HANDOFF_FRAGMENT_RAMP));
}

function localPiecePose(effect, piece, index, amount, now, mode) {
  const level = smoother(amount);
  const seed = hash(effect.seed + index * 7.31);
  const windX = effect.windX || 0;
  const windY = effect.windY || 0;
  const speed = Math.min(34, Math.hypot(windX, windY));
  const direction = Math.atan2(windY || -2, windX || 9);
  const time = now * 0.001;
  let x = 0;
  let y = 0;
  let rotation = 0;

  switch (mode) {
    case "sigil-eye": {
      const sign = index % 2 ? -1 : 1;
      const phase = time * (2 + seed * 1.2) + sign * index * 0.68;
      const orbit = (18 + seed * 24 + speed * 0.72) * level;
      x = sign * 18 * level + Math.cos(phase) * orbit + Math.cos(direction) * speed * 0.5 * level;
      y = Math.sin(phase) * orbit * 0.72 + Math.sin(direction) * speed * 0.5 * level;
      rotation = sign * (0.18 + seed * 0.26) * level;
      break;
    }
    case "pearl-current": {
      const cross = Math.sin(time * (3.1 + seed) + index * 0.37) * (8 + seed * 14);
      const stream = 20 + seed * 38 + speed * 1.15;
      x = (Math.cos(direction) * stream - Math.sin(direction) * cross) * level;
      y = (Math.sin(direction) * stream + Math.cos(direction) * cross) * level;
      break;
    }
    case "ink-depth": {
      const position = index / Math.max(1, effect.fragments.length - 1) - 0.5;
      const depth = seed * 2 - 1;
      const lift = (12 + seed * 24 + speed * 0.35) * level;
      x = (Math.cos(direction) * speed * 0.45 + Math.sin(time * 2.2 + position * 8) * 12) * level;
      y = (Math.sin(direction) * speed * 0.35 - lift + position * 20) * level;
      rotation = depth * 0.14 * level;
      break;
    }
    case "negative-field": {
      const angle = Math.atan2(
        piece.y + piece.height / 2 - (effect.glyph.rect.top + effect.glyph.rect.height / 2),
        piece.x + piece.width / 2 - (effect.glyph.rect.left + effect.glyph.rect.width / 2),
      ) + (seed - 0.5) * 0.75;
      const rim = (24 + seed * 42 + speed * 0.55) * level;
      x = Math.cos(angle) * rim + Math.cos(direction) * speed * 0.32 * level;
      y = Math.sin(angle) * rim + Math.sin(direction) * speed * 0.32 * level;
      break;
    }
    case "dragon-bone": {
      const position = index / Math.max(1, effect.fragments.length - 1);
      const joint = Math.sin(time * 2.5 - position * Math.PI * 2.4 + effect.seed * 0.0002);
      const follow = (16 + position * 30 + speed * 0.48) * level;
      x = (Math.cos(direction) * follow + Math.cos(direction + Math.PI / 2) * joint * 18) * level;
      y = (Math.sin(direction) * follow + Math.sin(direction + Math.PI / 2) * joint * 18) * level;
      rotation = joint * 0.2 * level;
      break;
    }
    case "powder-wind": {
      const ray = direction + (seed - 0.5) * 1.4;
      const blast = (20 + seed * 44 + speed * 1.8) * level;
      const curl = Math.sin(time * 4.2 + piece.point?.phase * TWO_PI) * 8 * level;
      x = Math.cos(ray) * blast - Math.sin(ray) * curl;
      y = Math.sin(ray) * blast + Math.cos(ray) * curl;
      break;
    }
    case "dragon-draft": {
      const phase = time * (2.6 + seed) + index * 0.27;
      const stream = (24 + seed * 42 + speed) * level;
      x = Math.cos(direction) * stream + Math.cos(phase) * 15 * level;
      y = Math.sin(direction) * stream + Math.sin(phase) * 11 * level;
      break;
    }
    case "cursive-ash": {
      const sway = Math.sin(time * 3.7 + index * 0.41) * (10 + seed * 13);
      x = (Math.cos(direction) * (12 + speed) + sway) * level;
      y = (Math.sin(direction) * (12 + speed) - 24 - seed * 32) * level;
      break;
    }
    case "typhoon-typeset": {
      const centerX = effect.glyph.rect.left + effect.glyph.rect.width / 2;
      const centerY = effect.glyph.rect.top + effect.glyph.rect.height / 2;
      const pieceX = piece.x + piece.width / 2;
      const pieceY = piece.y + piece.height / 2;
      const radiusX = pieceX - centerX;
      const radiusY = pieceY - centerY;
      const angle = level * (1.3 + seed * 1.6) + time * 0.55;
      x = radiusX * Math.cos(angle) - radiusY * Math.sin(angle) - radiusX
        + Math.cos(direction) * speed * level;
      y = radiusX * Math.sin(angle) + radiusY * Math.cos(angle) - radiusY
        + Math.sin(direction) * speed * level;
      break;
    }
    case "fracture-cascade": {
      const delay = index / Math.max(1, effect.fragments.length - 1) * 0.34;
      const impulse = smoother(clamp((level - delay) / Math.max(0.01, 1 - delay)));
      const angle = direction + (seed - 0.5) * 2.2;
      const distance = 20 + seed * 40 + speed * 0.8;
      x = Math.cos(angle) * distance * impulse;
      y = Math.sin(angle) * distance * impulse - 8 * impulse * impulse;
      rotation = (seed - 0.5) * 1.5 * impulse;
      break;
    }
    case "scale-current": {
      const rowPhase = (piece.row || 0) * 0.7 + (piece.column || 0) * 0.35;
      const wave = Math.sin(time * 3.2 + rowPhase + effect.seed * 0.0001);
      x = (Math.cos(direction) * (18 + speed) + wave * 18) * level;
      y = (Math.sin(direction) * (18 + speed) + Math.cos(time * 2.4 + rowPhase) * 10) * level;
      rotation = wave * 0.22 * level;
      break;
    }
    case "calligraphic-shards": {
      const position = index / Math.max(1, effect.fragments.length - 1) - 0.5;
      const sweep = Math.sin(position * Math.PI + time * 1.8 + effect.seed * 0.0001);
      x = (sweep * (25 + Math.abs(position) * 20) + Math.cos(direction) * speed * 0.65) * level;
      y = (position * 28 + Math.cos(position * TWO_PI + time * 1.3) * 6
        + Math.sin(direction) * speed * 0.65) * level;
      rotation = sweep * 0.15 * level;
      break;
    }
    case "laminar-loong": {
      const lane = (piece.row || index) - (piece.rows || effect.fragments.length) / 2;
      const wave = Math.sin(time * 3 + lane * 0.62 + effect.seed * 0.0002);
      x = (Math.cos(direction) * (16 + speed) + wave * (18 + Math.abs(lane) * 2)) * level;
      y = (Math.sin(direction) * (16 + speed) + lane * 3.2) * level;
      rotation = wave * 0.055 * level;
      break;
    }
    case "brushwake": {
      const position = index / Math.max(1, effect.fragments.length - 1);
      const wake = Math.sin(position * Math.PI + time * 2.2);
      x = (Math.cos(direction) * (28 + speed * 1.25) + wake * 28) * level;
      y = (Math.sin(direction) * (28 + speed) + (position - 0.5) * 36 + Math.cos(time * 2 + position * 8) * 7) * level;
      rotation = wake * 0.19 * level;
      break;
    }
    case "dual-attractor": {
      const sign = index % 2 ? -1 : 1;
      const phase = time * (2.2 + seed) + index * 0.73;
      x = (sign * 28 + Math.cos(phase) * (16 + seed * 14) + Math.cos(direction) * speed * 0.6) * level;
      y = (Math.sin(phase) * (18 + seed * 12) + Math.sin(direction) * speed * 0.6) * level;
      rotation = sign * (0.2 + seed * 0.18) * level;
      break;
    }
    default:
      break;
  }
  return { x, y, rotation };
}

function drawLocalEffect(context, effect, amount, now, mode) {
  const { glyph, fragments, points, seed } = effect;
  const envelope = smoother(amount);
  if (amount < 0.002) {
    if (isTiledImageGlyph(glyph)) return;
    drawGlyph(context, glyph);
    return;
  }
  if (PARTICLE_MODES.has(mode)) {
    context.fillStyle = glyph.color;
    for (let index = 0; index < fragments.length; index += 1) {
      const fragment = fragments[index];
      const pose = localPiecePose(effect, fragment, index, amount, now, mode);
      context.fillRect(
        fragment.x + pose.x,
        fragment.y + pose.y,
        fragment.width,
        fragment.height,
      );
    }
    context.globalAlpha = 1;
    return;
  }
  if (POSED_FRAGMENT_MODES.has(mode)) {
    // Near rest, separately clipped image fragments can reveal their shared
    // boundaries. Whole logos keep one intact draw near rest; tiled photos use
    // the untouched DOM bitmap beneath a mix-matched source mask. Both arrive
    // at the original tiled explosion once the pieces visibly separate.
    const fragmentMix = glyph.kind === "image" ? wholeImageFragmentMix(amount) : 1;
    if (glyph.wholeImage && fragmentMix < 0.998) {
      drawGlyph(context, glyph, 1 - fragmentMix);
    }
    if (mode === "ink-depth") {
      fragments.forEach((fragment, index) => {
        const pose = localPiecePose(effect, fragment, index, amount, now, mode);
        drawGlyphFragment(
          context,
          effect,
          fragment,
          pose.x + 3.5 * envelope,
          pose.y + 5.5 * envelope,
          pose.rotation,
          0.11 * envelope * fragmentMix,
        );
      });
    }
    if (fragmentMix > 0.002) {
      fragments.forEach((fragment, index) => {
        const pose = localPiecePose(effect, fragment, index, amount, now, mode);
        drawGlyphFragment(
          context,
          effect,
          fragment,
          pose.x,
          pose.y,
          pose.rotation,
          fragmentMix,
        );
      });
    }
    context.globalAlpha = 1;
    return;
  }
  switch (mode) {
    case "latent-diffusion": {
      drawGlyph(context, glyph, 1 - envelope * 0.93);
      context.fillStyle = glyph.color;
      for (const point of points) {
        const curl = Math.sin(now * 0.004 + point.phase * TWO_PI) * 5 * envelope;
        const x = glyph.rect.left + point.x + point.dx * envelope - point.dy * 0.07 * curl;
        const y = glyph.rect.top + point.y + point.dy * envelope + point.dx * 0.04 * curl;
        context.globalAlpha = envelope * (0.46 + envelope * 0.52);
        context.beginPath();
        context.arc(x, y, point.size * (0.8 + envelope * 0.5), 0, TWO_PI);
        context.fill();
      }
      break;
    }
    case "shard-glass": {
      fragments.forEach((fragment, index) => {
        const angle = hash(seed + index * 4.3) * TWO_PI;
        const distance = 13 + hash(seed + index * 9.1) * 31;
        drawGlyphFragment(
          context,
          effect,
          fragment,
          Math.cos(angle) * distance * envelope,
          Math.sin(angle) * distance * envelope,
          (hash(seed + index * 3.7) - 0.5) * 1.2 * envelope,
        );
      });
      break;
    }
    case "fracture-cascade": {
      fragments.forEach((fragment, index) => {
        const delay = index / Math.max(1, fragments.length - 1) * 0.38;
        const impulse = smoother(clamp((envelope - delay) / Math.max(0.01, 1 - delay)));
        const angle = hash(seed + index * 4.7) * TWO_PI;
        const distance = 18 + hash(seed + index * 8.9) * 36;
        drawGlyphFragment(
          context,
          effect,
          fragment,
          Math.cos(angle) * distance * impulse,
          Math.sin(angle) * distance * impulse - 7 * impulse * impulse,
          (hash(seed + index * 2.9) - 0.5) * 1.4 * impulse,
        );
      });
      break;
    }
    case "magnetic-shards": {
      const glyphCenterX = glyph.rect.left + glyph.rect.width / 2;
      const glyphCenterY = glyph.rect.top + glyph.rect.height / 2;
      fragments.forEach((fragment, index) => {
        const centerX = fragment.x + fragment.width / 2;
        const centerY = fragment.y + fragment.height / 2;
        const restX = centerX - glyphCenterX;
        const restY = centerY - glyphCenterY;
        const direction = index % 2 ? -1 : 1;
        const angle = direction * (0.42 + hash(seed + index) * 0.55) * envelope
          + Math.sin(now * 0.0022 + index) * 0.11 * envelope;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const rotatedX = restX * cosine - restY * sine;
        const rotatedY = restX * sine + restY * cosine;
        const length = Math.max(1, Math.hypot(restX, restY));
        const expansion = (12 + hash(seed + index * 3.1) * 12) * envelope;
        drawGlyphFragment(
          context,
          effect,
          fragment,
          rotatedX - restX + restX / length * expansion,
          rotatedY - restY + restY / length * expansion,
          direction * 0.24 * envelope,
        );
      });
      break;
    }
    case "calligraphic-shards": {
      fragments.forEach((fragment, index) => {
        const position = index / Math.max(1, fragments.length - 1) - 0.5;
        const sweep = Math.sin(position * Math.PI + now * 0.0018 + seed * 0.0001);
        drawGlyphFragment(
          context,
          effect,
          fragment,
          sweep * (24 + Math.abs(position) * 18) * envelope,
          position * 26 * envelope + Math.cos(position * Math.PI * 2 + now * 0.0013) * 5 * envelope,
          sweep * 0.13 * envelope,
        );
      });
      break;
    }
    case "echo-shards": {
      fragments.forEach((fragment, index) => {
        const angle = hash(seed + index * 5.3) * TWO_PI;
        const distance = 18 + hash(seed + index * 9.7) * 30;
        const dx = Math.cos(angle) * distance * envelope;
        const dy = Math.sin(angle) * distance * envelope;
        const rotation = (hash(seed + index * 3.9) - 0.5) * 0.8 * envelope;
        drawGlyphFragment(context, effect, fragment, dx * 0.28, dy * 0.28, rotation * 0.28, 0.1);
        drawGlyphFragment(context, effect, fragment, dx * 0.55, dy * 0.55, rotation * 0.55, 0.18);
        drawGlyphFragment(context, effect, fragment, dx * 0.78, dy * 0.78, rotation * 0.78, 0.3);
        drawGlyphFragment(context, effect, fragment, dx, dy, rotation, 0.74);
      });
      break;
    }
    case "stroke-loong": {
      drawGlyph(context, glyph, 1 - envelope * 0.24);
      context.strokeStyle = glyph.color;
      context.lineWidth = Math.max(0.5, glyph.fontSize * 0.045);
      context.globalAlpha = envelope * 0.82;
      for (let branch = 0; branch < 8; branch += 1) {
        const side = branch % 2 ? 1 : -1;
        const originX = glyph.rect.left + glyph.rect.width * hash(seed + branch * 5.2);
        const originY = glyph.rect.top + glyph.rect.height * hash(seed + branch * 8.4);
        context.beginPath();
        context.moveTo(originX, originY);
        for (let segment = 1; segment <= 5; segment += 1) {
          const t = segment / 5;
          const reach = (11 + branch * 2.6) * envelope;
          context.lineTo(
            originX + side * reach * t + Math.sin(t * 8 + branch) * 2.4 * envelope,
            originY + (hash(seed + branch * 11) - 0.5) * reach * t,
          );
        }
        context.stroke();
      }
      break;
    }
    case "fluid-ink": {
      drawGlyph(context, glyph, 1 - envelope * 0.88);
      context.fillStyle = glyph.color;
      for (const point of points) {
        const localX = point.x - glyph.rect.width / 2;
        const localY = point.y - glyph.rect.height / 2;
        const direction = point.x < glyph.rect.width / 2 ? -1 : 1;
        const angle = direction * envelope * (2.4 + point.phase + now * 0.00028);
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const x = glyph.rect.left + glyph.rect.width / 2 + localX * cosine - localY * sine;
        const y = glyph.rect.top + glyph.rect.height / 2 + localX * sine + localY * cosine;
        context.globalAlpha = envelope * (0.45 + envelope * 0.5);
        context.fillRect(x, y, point.size, point.size);
      }
      break;
    }
    case "morphogen": {
      drawGlyph(context, glyph, 1 - envelope * 0.43);
      context.fillStyle = glyph.color;
      context.strokeStyle = glyph.color;
      context.globalAlpha = envelope * 0.68;
      for (let node = 0; node < 14; node += 1) {
        const angle = node * 2.399963 + seed;
        const radius = Math.sqrt((node + 1) / 14) * 27 * envelope;
        const x = glyph.rect.left + glyph.rect.width / 2 + Math.cos(angle) * radius;
        const y = glyph.rect.top + glyph.rect.height / 2 + Math.sin(angle) * radius * 0.62;
        context.beginPath();
        context.arc(x, y, 0.8 + (node % 4) * 0.55, 0, TWO_PI);
        context.fill();
        if (node > 3) {
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(
            glyph.rect.left + glyph.rect.width / 2 + Math.cos(angle - 2.399963) * radius * 0.63,
            glyph.rect.top + glyph.rect.height / 2 + Math.sin(angle - 2.399963) * radius * 0.4,
          );
          context.stroke();
        }
      }
      break;
    }
    case "page-fault": {
      fragments.forEach((fragment, index) => {
        const direction = index % 2 ? 1 : -1;
        const aftershock = Math.sin(envelope * Math.PI * 7 + index) * 2.6 * envelope;
        drawGlyphFragment(
          context,
          effect,
          fragment,
          direction * (11 + index * 1.4) * envelope + aftershock,
          direction * envelope * 0.7,
        );
      });
      break;
    }
    case "quadtree-fold": {
      fragments.forEach((fragment, index) => {
        const gray = index ^ (index >> 1);
        const angle = gray / Math.max(1, fragments.length - 1) * TWO_PI;
        drawGlyphFragment(
          context,
          effect,
          fragment,
          Math.cos(angle) * 16 * envelope,
          Math.sin(angle) * 16 * envelope,
          Math.sin(angle * 2) * 0.22 * envelope,
        );
      });
      break;
    }
    case "standing-wave": {
      fragments.forEach((fragment, index) => {
        const node = Math.sin(index / Math.max(1, fragments.length - 1) * Math.PI * 3);
        const impulse = Math.sin(now * 0.008 + index * 0.9);
        drawGlyphFragment(context, effect, fragment, node * impulse * 22 * envelope, 0);
      });
      break;
    }
    case "moire-wave": {
      fragments.forEach((fragment, index) => {
        const direction = index % 2 ? -1 : 1;
        const waveA = Math.sin(now * 0.006 + index * 0.72);
        const waveB = Math.sin(now * 0.0041 - index * 1.07);
        drawGlyphFragment(
          context,
          effect,
          fragment,
          direction * (waveA + waveB) * 12 * envelope,
          (waveA - waveB) * 2.8 * envelope,
          direction * waveA * 0.028 * envelope,
        );
      });
      break;
    }
    case "soliton-wave": {
      const travel = ((now - effect.createdAt) * 0.00042) % 1.35 - 0.16;
      fragments.forEach((fragment, index) => {
        const position = index / Math.max(1, fragments.length - 1);
        const packet = Math.exp(-(((position - travel) / 0.16) ** 2));
        drawGlyphFragment(
          context,
          effect,
          fragment,
          packet * (30 + index * 0.8) * envelope,
          Math.sin(position * Math.PI) * packet * 5 * envelope,
          packet * 0.055 * envelope,
        );
      });
      break;
    }
    case "seismic-wave": {
      const cycle = ((now - effect.createdAt) % 1450) / 1450;
      const decay = Math.exp(-cycle * 3.4);
      fragments.forEach((fragment, index) => {
        const quake = Math.sin(cycle * Math.PI * 14 - index * 1.3) * decay;
        drawGlyphFragment(
          context,
          effect,
          fragment,
          quake * (24 + index * 6) * envelope,
          Math.cos(cycle * Math.PI * 9 + index) * 4 * decay * envelope,
          quake * 0.11 * envelope,
        );
      });
      break;
    }
    case "interference-wave": {
      fragments.forEach((fragment) => {
        const u = (fragment.column + 0.5) / fragment.columns;
        const v = (fragment.row + 0.5) / fragment.rows;
        const modeA = Math.sin(Math.PI * 2 * u) * Math.sin(Math.PI * 3 * v);
        const modeB = Math.sin(Math.PI * 3 * u) * Math.sin(Math.PI * 2 * v);
        const oscillationA = Math.sin(now * 0.006 + seed * 0.0002);
        const oscillationB = Math.sin(now * 0.0043 - seed * 0.00017);
        drawGlyphFragment(
          context,
          effect,
          fragment,
          (modeA * oscillationA + modeB * oscillationB) * 19 * envelope,
          (modeA * oscillationB - modeB * oscillationA) * 11 * envelope,
          (modeA + modeB) * 0.045 * envelope,
        );
      });
      break;
    }
    case "cellular": {
      drawGlyph(context, glyph, 1 - envelope * 0.8);
      context.fillStyle = glyph.color;
      const generation = Math.floor(now / 95);
      points.forEach((point, index) => {
        if (hash(index * 13 + generation * 7 + seed) < 0.34 + envelope * 0.22) return;
        const drift = ((generation + index) % 5) - 2;
        const x = glyph.rect.left + Math.round(point.x / 2) * 2 + drift * envelope;
        const y = glyph.rect.top + Math.round(point.y / 2) * 2;
        context.globalAlpha = envelope * (0.55 + envelope * 0.44);
        context.fillRect(x, y, 1.5 + envelope, 1.5 + envelope);
      });
      break;
    }
    case "woven": {
      fragments.forEach((fragment, index) => {
        const direction = index % 2 ? 1 : -1;
        drawGlyphFragment(context, effect, fragment, 0, direction * (10 + index) * envelope, direction * envelope * 0.025);
      });
      context.strokeStyle = glyph.color;
      context.globalAlpha = envelope * 0.5;
      context.lineWidth = 0.65;
      for (let row = 1; row <= 5; row += 1) {
        const y = glyph.rect.top + row / 6 * glyph.rect.height;
        context.beginPath();
        context.moveTo(glyph.rect.left - envelope * 9, y);
        context.lineTo(glyph.rect.right + envelope * 9, y + (row % 2 ? 1 : -1) * envelope * 3);
        context.stroke();
      }
      break;
    }
  }
  context.globalAlpha = 1;
}

function seedSceneHandoff(scene, effects, now, study) {
  const epsilon = 12;
  scene.tokens.length = scene.baseTokenCount || scene.tokens.length;
  const fragmentMixFor = imageFragmentMix;
  const individualRects = [];
  for (const effect of effects.values()) {
    const fragmentMix = fragmentMixFor(effect);
    if (isTiledImageGlyph(effect.glyph)) {
      individualRects.push({
        ...imageMaskGeometry(effect.glyph),
        fragmentMix,
      });
      continue;
    }
    individualRects.push({
      ...effect.glyph.rect,
      fragmentMix,
    });
  }
  scene.handoffRects = individualRects;
  const futureStates = new Map();
  const handoffFor = (effect, piece, sourceCenter) => {
    let futureState = futureStates.get(effect.glyph.key);
    if (!futureState) {
      futureState = criticalSpringState(
        effect.level,
        effect.levelVelocity || 0,
        effect.target,
        epsilon / 1000,
        effect.springOmega || 7,
      );
      futureStates.set(effect.glyph.key, futureState);
    }
    const pose = localPiecePose(effect, piece, piece.pieceIndex, effect.level, now, study.mode);
    const futurePose = localPiecePose(
      effect,
      piece,
      piece.pieceIndex,
      futureState.level,
      now + epsilon,
      study.mode,
    );
    return {
      sourceId: piece.sourceId,
      x: sourceCenter.x + pose.x,
      y: sourceCenter.y + pose.y,
      rotation: pose.rotation,
      level: effect.level,
      fragmentMix: fragmentMixFor(effect),
      vx: (futurePose.x - pose.x) / epsilon,
      vy: (futurePose.y - pose.y) / epsilon,
      angularVelocity: (futurePose.rotation - pose.rotation) / epsilon,
    };
  };

  for (const token of scene.tokens) {
    token.handoff = null;
    const piece = token.source;
    if (!piece?.glyphKey) continue;
    const effect = effects.get(piece.glyphKey);
    if (!effect) continue;
    const localPiece = effect.fragments[piece.pieceIndex];
    if (!localPiece) continue;
    const sourceCenter = center(piece, token.sourceCenter);
    token.handoff = handoffFor(effect, localPiece, sourceCenter);
  }

  // Local effects keep their full detail while the base global field is capped.
  // Carry every active piece omitted by the deterministic global sample into
  // the shared dragon as a source-only token. This preserves the exact final
  // hover frame without returning to clean text or creating a threshold freeze.
  if (scene.tokens.length) {
    const knownSourceIds = new Set(scene.tokens.map(({ sourceId }) => sourceId).filter(Boolean));
    const anchorTokens = scene.tokens.slice();
    const anchorTokensByRole = {
      image: anchorTokens.filter(({ sourceInk }) => sourceInk?.imageTile),
      type: anchorTokens.filter(({ sourceInk }) => !sourceInk?.imageTile),
    };
    for (const effect of effects.values()) {
      for (const piece of effect.fragments) {
        if (knownSourceIds.has(piece.sourceId)) continue;
        const seed = hashString(piece.sourceId);
        const roleAnchors = piece.imageTile
          ? anchorTokensByRole.image
          : anchorTokensByRole.type;
        const candidates = roleAnchors.length ? roleAnchors : anchorTokens;
        const anchorToken = candidates[Math.floor(seed * candidates.length) % candidates.length];
        const midpoint = {
          x: anchorToken.midpoint.x + (hash(seed * 31.7) - 0.5) * 2.4,
          y: anchorToken.midpoint.y + (hash(seed * 47.9) - 0.5) * 2.4,
          motif: anchorToken.midpointRole,
        };
        const index = scene.tokens.length;
        const sourceCenter = center(piece, midpoint);
        const token = {
          index,
          source: piece,
          target: null,
          sourceInk: piece,
          targetInk: null,
          sourceOrigin: piece,
          targetDestination: null,
          sourceCenter,
          targetCenter: midpoint,
          midpoint,
          midpointRole: midpoint.motif,
          sourceId: piece.sourceId,
          seed,
          fieldPhase: hash(index * 9.71 + Number(study.number) * 53) * TWO_PI,
          fieldSign: index % 2 ? -1 : 1,
          depth: hash(index * 5.93 + Number(study.number) * 17) * 2 - 1,
        };
        token.handoff = handoffFor(effect, piece, sourceCenter);
        scene.tokens.push(token);
        knownSourceIds.add(piece.sourceId);
      }
    }
  }
  if (scene.passiveMidpointMotion) {
    preparePassiveMidpoint(scene.tokens, scene.midpointBounds);
  }
  scene.midpointIndex = midpointSpatialIndex(scene.tokens);
}

export async function mountMatterExperience({
  root,
  layers,
  globalCanvas,
  localCanvas,
  study,
  ageElement,
  clock,
  clockControl,
  disturbTrack,
  soundButton,
}) {
  // renderStudy() calls mount in the same task that inserts the page. Seed the
  // real value before this function's first await, so a zero-age placeholder
  // can never reach the first paint while fonts and images load.
  function seedLiveAge() {
    const text = formatLiveAge();
    for (const layer of layers) {
      for (const element of layer.querySelectorAll(".live-age")) {
        element.textContent = text;
      }
    }
  }
  seedLiveAge();
  await document.fonts?.ready;

  // Tiles are cut from the laid-out box and sampled from the bitmap, so both
  // have to exist before anything is captured.
  const diffusableImages = layers.flatMap((layer, index) => (
    [...layer.querySelectorAll("img[data-diffuse]")].map((image, order) => {
      image.dataset.imageKey = `${index ? "b" : "a"}:img${order}`;
      return image;
    })
  ));
  await Promise.all(diffusableImages.map((image) => (
    image.complete && image.naturalWidth
      ? Promise.resolve()
      : image.decode().catch(() => {})
  )));

  // One screen, no scrolling. Both faces are laid out even while hidden, so
  // each can be measured and fitted independently before anything is captured.
  const quality = createQuality();
  const performanceProfile = quality.performanceProfile;
  const photos = createPhotos({
    layers,
    tileTarget: performanceProfile.imageTileTarget,
    ...performanceProfile.photo,
  });

  // Multi-column pages overflow *sideways*, not downward: content that does
  // not fit the fixed height spills into a third column past the right edge.
  // Checking height alone therefore never sees the overflow it is trying to
  // solve, and the loop walks the type all the way down to the floor.
  function overflows(page) {
    const allowsVerticalScroll = getComputedStyle(page).overflowY === "auto";
    return (!allowsVerticalScroll && page.scrollHeight > page.clientHeight + 1)
      || page.scrollWidth > page.clientWidth + 1;
  }

  function fitFace(layer) {
    const page = layer.querySelector(".default-page");
    // A page mounted into a zero-sized window — a background tab, a collapsed
    // pane — measures every box as empty, so the loop would floor the type and
    // the photo surfaces would never be built. Leave it alone; the resize
    // observer refits the moment the box is real.
    if (!page || page.clientWidth < 8 || page.clientHeight < 8) return;
    let size = FIT_MAX_PX;
    page.style.fontSize = `${size}px`;
    while (overflows(page) && size > FIT_MIN_PX) {
      size -= FIT_STEP_PX;
      page.style.fontSize = `${size}px`;
    }
  }

  // Callers that refit after mount must follow this with `aging.remeasure()`:
  // pinned corruption widths were taken against the previous type size. It is
  // not called from here because this runs once before `aging` exists, and a
  // reference to it then is a temporal dead zone error, which optional
  // chaining does not protect against.
  function fitFaces() {
    layers.forEach(fitFace);
    photos.rebuild();
  }

  const midpointMask = await loadSamplingMask(study.midpoint).catch(() => null);
  const midpointVariants = midpointVariantsFor(study, quality.tier);
  let queuedMidpoint = chooseMidpointVariant(midpointVariants);
  // Asset loading may take long enough for the last decimals to advance.
  // Refresh once more before the value becomes fixed-width glyph tokens.
  seedLiveAge();
  layers.forEach((layer, index) => prepareGlyphTokens(layer, index ? "b" : "a"));
  fitFaces();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let globalSurface = setupCanvas(globalCanvas, quality.globalDprCap);
  let localSurface = setupCanvas(localCanvas, quality.localDprCap);
  let captures = layers.map((layer) => captureLayer(
    layer,
    localSurface.context,
    performanceProfile.imageTileTarget,
  ));
  let captureReferenceCounts = captures.map(captureReferenceParticleCount);
  let indexes = captures.map(spatialIndex);
  let scrollPositions = layers.map((layer) => layer.querySelector(".default-page")?.scrollTop || 0);
  let currentFace = 0;
  let phase = "stable";
  let inputEnabled = !reducedMotion.matches;
  let transitioning = false;
  let triggered = false;
  let destroyed = false;
  let localFrame = 0;
  let globalFrame = 0;
  let pointerFrame = 0;
  let lastLocalPaintAt = 0;
  let lastPointerFlushAt = 0;
  let lastMidpointPointerFlushAt = 0;
  let resizeTimer = 0;
  let scrollTimer = 0;
  let pendingResize = false;
  let pendingCapture = false;
  let lastPoint = null;
  let lastPointerAt = 0;
  let pointerVelocity = { x: 8, y: 0 };
  let pointerPoint = null;
  let pendingPointerPoints = [];
  let activeScene = null;
  let localDirtyRects = [];
  let sceneGeneration = 0;
  let atlasCache = [null, null];
  let chromeCache = [null, null];
  const sceneCache = new Map();
  const scenePromises = new Map();
  const effects = new Map();
  const retiredEffects = new Map();
  const inkCache = new Map();
  const inkShapeCache = new Map();
  const memory = new Map();
  const midpointEffects = new Map();
  const retiredMidpointEffects = new Map();
  const midpointMemory = new Map();
  let midpointPointer = null;
  let midpointFrame = 0;
  let lastMidpointPaintAt = 0;
  let lastProgressText = "";
  let lastActiveCount = -1;
  let lastHeldCount = -1;
  let flashStartedAt = 0;
  let lastSwimAt = 0;
  let agingDirty = false;
  let agingSyncTimer = 0;
  let ageState = null;
  let lastAgeText = "";
  let countdownFrame = 0;
  let rewindingAge = false;
  let clockDragging = false;
  let clockPointerId = null;
  let clockLastAngle = null;
  let clockPendingElapsed = 0;
  let clockDragFrame = 0;
  let clockSyncFrame = 0;
  let clockSyncReleaseFrame = 0;
  let clockCaptureTimer = 0;
  let clockReconciling = false;
  let clockReconcileFrame = 0;
  let clockReconcilePromise = Promise.resolve();
  let resolveClockReconcile = null;
  let clockResumeAfterReconcile = true;
  let clockCaptureAfterReconcile = true;
  let photoAgeSettled = true;
  let charge = 0;
  let lastDrainAt = 0;
  const restoreKeys = new Set();
  let captureMaps = captures.map(
    (glyphs) => new Map(glyphs.map((glyph) => [glyph.key, glyph])),
  );

  const audio = createAudio();
  const favicon = createAgingFavicon();
  const aging = createAging({
    layers,
    palette: { ink: INK_RGB, paper: PAPER_RGB },
    performance: performanceProfile.aging,
    onState(state, {
      immediate = false,
      settle = false,
    } = {}) {
      ageState = state;
      // The photographs run off the same clock as the type.
      const photoResult = photos.setElapsed(state.elapsed, { immediate, settle });
      photoAgeSettled = photoResult.settled;
      if (photoResult.painted) agingDirty = true;
      updateAgeReadout();
    },
  });

  // Rendered at a fixed width so the token count never changes: the digits are
  // rewritten inside the existing glyph tokens, which keeps the number
  // corruptible and part of the dragon rather than a dead island of live text.
  let ageTokens = null;

  function refreshLiveAge() {
    if (!ageTokens) {
      ageTokens = layers.flatMap((layer) => (
        [...layer.querySelectorAll(".live-age .glyph-token")]
      ));
      if (!ageTokens.length) return;
    }
    const text = formatLiveAge();
    for (let index = 0; index < ageTokens.length; index += 1) {
      const token = ageTokens[index];
      const character = text[index] ?? " ";
      if (token.dataset.character === character) continue;
      token.dataset.character = character;
      const ink = token.querySelector(":scope > .glyph-ink");
      if (ink) ink.textContent = character;
    }
  }
  refreshLiveAge();

  function writeAgeLine(seconds) {
    const whole = Math.max(0, Math.round(seconds));
    const text = `this page is ${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")} old`;
    if (ageElement && text !== lastAgeText) {
      ageElement.textContent = text;
      lastAgeText = text;
    }
    clockControl?.setAttribute("aria-valuenow", String(whole));
    clockControl?.setAttribute("aria-valuetext", text);
  }

  // The tab title rots along with the page. It is re-derived on every publish
  // from the same corruption fraction the body text is using, with a rolling
  // seed so the wrong characters keep moving rather than freezing into one
  // misspelling.
  const BASE_TITLE = document.title;
  let titleSeed = 0;

  function corruptTitle(fraction) {
    if (fraction <= 0.002) {
      if (document.title !== BASE_TITLE) document.title = BASE_TITLE;
      return;
    }
    titleSeed += 1;
    let out = "";
    for (let index = 0; index < BASE_TITLE.length; index += 1) {
      const character = BASE_TITLE[index];
      if (character === " ") {
        out += character;
        continue;
      }
      const roll = hash(index * 7.31 + Math.floor(titleSeed / 2) * 0.618);
      out += roll < fraction ? titleNoise(index + titleSeed) : character;
    }
    if (out !== document.title) document.title = out;
  }

  function updateAgeReadout() {
    if (!ageState || rewindingAge) return;
    // Cumulative degrees, never an angle modulo a turn. The hand loops forward
    // as many times as it likes, and on a reset it has to travel backwards
    // through every one of those turns rather than take the short way round.
    clock?.style.setProperty("--hand-age", (ageState.turns * 360).toFixed(2));
    root.dataset.age = ageState.turns.toFixed(3);
    corruptTitle(ageState.corrupted || 0);
    favicon.setElapsed(ageState.elapsed);
    writeAgeLine(ageState.seconds);
  }

  // Corruption is drawn entirely in overlay pseudo-elements and never touches
  // the character the canvas reads, so captures do not go stale as the page
  // corrupts. This only has to catch a reset, which restores the pinned widths.
  function scheduleAgingSync() {
    if (
      !agingDirty
      || agingSyncTimer
      || clockDragging
      || clockReconciling
    ) return;
    agingSyncTimer = setTimeout(() => {
      agingSyncTimer = 0;
      if (destroyed || !agingDirty) return;
      if (
        clockDragging
        || clockReconciling
        || transitioning
        || phase !== "stable"
      ) return;
      agingDirty = false;
      rebuildCaptures(false, true);
    }, 1500);
  }

  function clockCanInteract() {
    return Boolean(
      clockControl
      && aging
      && phase === "stable"
      && !transitioning
      && !rewindingAge
      && root.dataset.owner === "dom"
    );
  }

  function syncClockControl() {
    if (!clockControl) return;
    clockControl.setAttribute(
      "aria-disabled",
      clockCanInteract() ? "false" : "true",
    );
  }

  function clockAngleAt(point) {
    if (!clockControl) return null;
    const rect = clockControl.getBoundingClientRect();
    const deltaX = point.clientX - (rect.left + rect.width / 2);
    const deltaY = point.clientY - (rect.top + rect.height / 2);
    const radius = Math.min(rect.width, rect.height) / 2;
    if (Math.hypot(deltaX, deltaY) < Math.max(5, radius * 0.14)) return null;
    // Zero is twelve o'clock; positive angles run clockwise in screen space.
    return Math.atan2(deltaX, -deltaY);
  }

  function applyPendingRestorations() {
    if (!restoreKeys.size) return;
    aging?.restore(restoreKeys);
    if (photos.restore(restoreKeys)) agingDirty = true;
    restoreKeys.clear();
  }

  function flushClockCaptureSync({ allowTransition = false } = {}) {
    clearTimeout(clockCaptureTimer);
    clockCaptureTimer = 0;
    clearTimeout(agingSyncTimer);
    agingSyncTimer = 0;
    if (
      !agingDirty
      || destroyed
      || clockDragging
      || clockReconciling
      || (transitioning && !allowTransition)
      || phase !== "stable"
    ) return false;
    agingDirty = false;
    rebuildCaptures(false, true);
    return true;
  }

  function scheduleClockCaptureSync() {
    clearTimeout(clockCaptureTimer);
    clockCaptureTimer = setTimeout(() => {
      clockCaptureTimer = 0;
      flushClockCaptureSync();
    }, 160);
  }

  function finishClockReconciliation() {
    if (!clockReconciling) return;
    clockReconciling = false;
    clockReconcileFrame = 0;
    const resumeAging = clockResumeAfterReconcile;
    const capture = clockCaptureAfterReconcile;
    clockResumeAfterReconcile = true;
    clockCaptureAfterReconcile = true;
    if (resumeAging && clockCanInteract()) aging?.setActive(true);
    if (capture) scheduleClockCaptureSync();
    const resolve = resolveClockReconcile;
    resolveClockReconcile = null;
    resolve?.();
  }

  function reconcileClockAgeFrame() {
    clockReconcileFrame = 0;
    if (!clockReconciling || destroyed || clockDragging) return;
    const textSettled = aging?.reconcile() ?? true;
    if (textSettled && photoAgeSettled) {
      finishClockReconciliation();
      return;
    }
    clockReconcileFrame = requestAnimationFrame(reconcileClockAgeFrame);
  }

  function reconcileClockAge({
    resumeAging = true,
    scheduleCapture = true,
  } = {}) {
    if (clockReconciling) {
      // A transition may tighten the promises made by a settlement that began
      // on pointer release. Once false, these flags stay false for that pass.
      clockResumeAfterReconcile &&= resumeAging;
      clockCaptureAfterReconcile &&= scheduleCapture;
    } else {
      clockReconciling = true;
      clockResumeAfterReconcile = resumeAging;
      clockCaptureAfterReconcile = scheduleCapture;
      clockReconcilePromise = new Promise((resolve) => {
        resolveClockReconcile = resolve;
      });
    }
    aging?.setActive(false);
    if (!clockReconcileFrame && !clockDragging) {
      clockReconcileFrame = requestAnimationFrame(reconcileClockAgeFrame);
    }
    return clockReconcilePromise;
  }

  function pauseClockReconciliation() {
    if (clockReconcileFrame) cancelAnimationFrame(clockReconcileFrame);
    clockReconcileFrame = 0;
  }

  function clearClockSyncHold() {
    if (clockSyncFrame) cancelAnimationFrame(clockSyncFrame);
    if (clockSyncReleaseFrame) cancelAnimationFrame(clockSyncReleaseFrame);
    clockSyncFrame = 0;
    clockSyncReleaseFrame = 0;
    delete clockControl?.dataset.clockSync;
  }

  function holdClockHandAtPointer() {
    clearClockSyncHold();
    if (!clockControl) return;
    clockControl.dataset.clockSync = "true";
    // The first frame renders the exact pointer-up angle with transitions
    // suppressed. The second restores normal easing after that state has
    // actually reached the screen, rather than relying on same-task styles.
    clockSyncFrame = requestAnimationFrame(() => {
      clockSyncFrame = 0;
      clockSyncReleaseFrame = requestAnimationFrame(() => {
        clockSyncReleaseFrame = 0;
        delete clockControl.dataset.clockSync;
      });
    });
  }

  function flushClockDragFrame() {
    clockDragFrame = 0;
    if (!clockDragging || !clockCanInteract()) return;
    aging?.setElapsed(clockPendingElapsed);
  }

  function queueClockPointer(event) {
    const coalesced = event.getCoalescedEvents?.() || [];
    const points = coalesced.length ? [...coalesced] : [event];
    const endpoint = points.at(-1);
    if (
      endpoint
      && (endpoint.clientX !== event.clientX || endpoint.clientY !== event.clientY)
    ) points.push(event);
    let changed = false;
    for (const point of points) {
      const angle = clockAngleAt(point);
      if (angle === null) {
        // Rebase after crossing the unstable centre instead of inventing a
        // half-turn when the pointer emerges on the other side.
        clockLastAngle = null;
        continue;
      }
      if (clockLastAngle !== null) {
        const delta = wrappedClockAngleDelta(clockLastAngle, angle);
        const previousElapsed = clockPendingElapsed;
        clockPendingElapsed = elapsedAfterClockDelta(previousElapsed, delta);
        changed = changed
          || Math.abs(clockPendingElapsed - previousElapsed) > 0.01;
      }
      clockLastAngle = angle;
    }
    if (changed && !clockDragFrame) {
      clockDragFrame = requestAnimationFrame(flushClockDragFrame);
    }
  }

  function endClockDrag({
    reconcile = true,
    resumeAging = true,
    scheduleCapture = true,
  } = {}) {
    if (!clockDragging) return;
    if (clockDragFrame) cancelAnimationFrame(clockDragFrame);
    clockDragFrame = 0;
    const pointerId = clockPointerId;
    clockPointerId = null;
    clockDragging = false;
    clockLastAngle = null;
    // Commit the exact endpoint while the no-transition drag style is still
    // present, so the hand cannot trail the pointer for another 460ms.
    if (reconcile) aging?.setElapsed(clockPendingElapsed);
    holdClockHandAtPointer();
    delete clockControl?.dataset.dragging;
    if (pointerId !== null) {
      try {
        if (clockControl?.hasPointerCapture(pointerId)) {
          clockControl.releasePointerCapture(pointerId);
        }
      } catch {
        // Capture may already have been released by the browser.
      }
    }
    if (reconcile) {
      void reconcileClockAge({ resumeAging, scheduleCapture });
    } else if (resumeAging && clockCanInteract()) {
      aging?.setActive(true);
    }
    syncClockControl();
  }

  function onClockPointerDown(event) {
    if (
      !clockCanInteract()
      || clockDragging
      || event.isPrimary === false
      || (event.pointerType === "mouse" && event.button !== 0)
    ) return;
    event.preventDefault();
    clearClockSyncHold();
    clockDragging = true;
    clockPointerId = event.pointerId;
    clockLastAngle = clockAngleAt(event);
    clockPendingElapsed = aging?.state?.elapsed ?? 0;
    clockControl.dataset.dragging = "true";
    clockControl.focus({ preventScroll: true });
    clearTimeout(clockCaptureTimer);
    clockCaptureTimer = 0;
    clearTimeout(agingSyncTimer);
    agingSyncTimer = 0;
    pauseClockReconciliation();
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    pendingPointerPoints = [];
    pointerPoint = null;
    midpointPointer = null;
    lastPoint = null;
    aging?.setActive(false);
    applyPendingRestorations();
    clockPendingElapsed = aging?.state?.elapsed ?? clockPendingElapsed;
    try {
      clockControl.setPointerCapture(event.pointerId);
    } catch {
      // Without capture, leaving the small dial can strand the page with
      // autonomous ageing paused. Abort cleanly instead.
      endClockDrag();
    }
  }

  function onClockPointerMove(event) {
    if (!clockDragging || event.pointerId !== clockPointerId) return;
    if (!clockCanInteract()) {
      endClockDrag({ resumeAging: false });
      return;
    }
    event.preventDefault();
    queueClockPointer(event);
  }

  function onClockPointerEnd(event) {
    if (!clockDragging || event.pointerId !== clockPointerId) return;
    event.preventDefault();
    queueClockPointer(event);
    endClockDrag();
  }

  function onClockPointerCancel(event) {
    if (!clockDragging || event.pointerId !== clockPointerId) return;
    event.preventDefault();
    // Cancellation coordinates can be stale or synthetic. Reconcile the last
    // accepted sample rather than introducing a surprise final jump.
    endClockDrag();
  }

  function onClockLostPointerCapture(event) {
    if (!clockDragging || event.pointerId !== clockPointerId) return;
    endClockDrag();
  }

  function onClockKeyDown(event) {
    if (!clockCanInteract() || clockDragging) return;
    applyPendingRestorations();
    let next = null;
    const elapsed = aging?.state?.elapsed || 0;
    const arrowStep = CLOCK_KEY_STEP_MS * (event.shiftKey ? 5 : 1);
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = elapsed + arrowStep;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = elapsed - arrowStep;
    } else if (event.key === "PageUp") {
      next = elapsed + REVOLUTION_MS / 4;
    } else if (event.key === "PageDown") {
      next = elapsed - REVOLUTION_MS / 4;
    } else if (event.key === "Home") {
      next = 0;
    }
    if (next === null) return;
    event.preventDefault();
    pauseClockReconciliation();
    aging?.setActive(false);
    aging?.setElapsed(Math.max(0, next));
    void reconcileClockAge();
  }

  // There is no button. The only way through is to disturb enough of the page
  // at once, so the gate is a charge rather than a count-in-a-window: every
  // newly touched character adds to it and it drains steadily whenever you
  // stop. The `memory` maps only supply distinctness — a character cannot
  // contribute again until its entry expires — so resting on one word does
  // almost nothing while sweeping across the page fills the bar quickly.
  function chargeTarget() {
    if (phase !== "midpoint") {
      if (quality.tier !== "mobile") return study.requiredCharacters;
      return particleScaledThreshold(
        study.requiredCharacters,
        captures[currentFace]?.length,
        captureReferenceCounts[currentFace],
      );
    }
    return particleScaledThreshold(
      study.midpointRequired,
      activeScene?.tokens?.length || activeScene?.baseTokenCount,
      GLOBAL_TRANSITION_TOKEN_LIMIT,
    );
  }

  function drainCharge(now) {
    const elapsed = lastDrainAt ? Math.min(1200, now - lastDrainAt) : 0;
    lastDrainAt = now;
    if (!elapsed || charge <= 0) return;
    const drainMs = phase === "midpoint" ? study.midpointDrainMs : study.drainMs;
    charge = Math.max(0, charge - (elapsed / drainMs) * chargeTarget());
    updateProgress();
  }

  function addCharge(amount) {
    if (!amount) return;
    charge = Math.min(chargeTarget() * 1.05, charge + amount);
    updateProgress();
  }

  function updateProgress() {
    const target = chargeTarget();
    const value = clamp(charge / Math.max(1, target));
    const shown = value.toFixed(3);
    root.dataset.disturbTarget = String(target);
    if (shown !== lastProgressText) {
      lastProgressText = shown;
      root.dataset.disturbed = shown;
      disturbTrack?.style.setProperty("--disturb", shown);
    }
  }

  function cleanMemory(now) {
    for (const [key, timestamp] of memory) {
      if (now - timestamp > study.windowMs) memory.delete(key);
    }
  }

  function cleanMidpointMemory(now) {
    for (const [key, timestamp] of midpointMemory) {
      if (now - timestamp > study.midpointWindowMs) midpointMemory.delete(key);
    }
  }

  function eraseEffectSources(active) {
    const context = localSurface.context;
    for (const effect of active) {
      const glyph = effect.glyph;
      if (isTiledImageGlyph(glyph)) {
        drawImageTileMask(
          context,
          imageMaskGeometry(glyph),
          imageFragmentMix(effect),
        );
        continue;
      }
      const rect = glyph.rect;
      context.fillStyle = PAPER;
      context.fillRect(rect.left, rect.top, rect.width, rect.height);
    }
  }

  function dirtyRectFor(rect, padding = Math.max(124, study.cursorRadius * 1.7)) {
    return {
      left: Math.max(0, Math.floor(rect.left - padding - 1)),
      top: Math.max(0, Math.floor(rect.top - padding - 1)),
      right: Math.min(localSurface.width, Math.ceil(rect.right + padding + 1)),
      bottom: Math.min(localSurface.height, Math.ceil(rect.bottom + padding + 1)),
    };
  }

  function mergeDirtyRects(rects, gap = 4) {
    const merged = [];
    for (const candidate of rects) {
      let rect = { ...candidate };
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        const other = merged[index];
        if (
          rect.right + gap < other.left
          || other.right + gap < rect.left
          || rect.bottom + gap < other.top
          || other.bottom + gap < rect.top
        ) continue;
        rect = {
          left: Math.min(rect.left, other.left),
          top: Math.min(rect.top, other.top),
          right: Math.max(rect.right, other.right),
          bottom: Math.max(rect.bottom, other.bottom),
        };
        merged.splice(index, 1);
      }
      merged.push(rect);
    }
    return merged;
  }

  function dirtyRectsForEffects(active) {
    const rects = [];
    for (const effect of active) {
      const glyph = effect.glyph;
      if (isTiledImageGlyph(glyph)) {
        const mask = imageMaskGeometry(glyph);
        const displacement = 112 * smoother(effect.level) + 3;
        rects.push(dirtyRectFor({
          left: Math.min(mask.left, glyph.rect.left - displacement),
          top: Math.min(mask.top, glyph.rect.top - displacement),
          right: Math.max(mask.right, glyph.rect.right + displacement),
          bottom: Math.max(mask.bottom, glyph.rect.bottom + displacement),
        }, 0));
        continue;
      }
      rects.push(dirtyRectFor(glyph.rect));
    }
    return mergeDirtyRects(rects);
  }

  function clearLocalDirty() {
    const context = localSurface.context;
    for (const rect of localDirtyRects) {
      context.clearRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
    }
    localDirtyRects = [];
  }

  function retireLocalEffect(key, effect, now) {
    if (retiredEffects.size >= performanceProfile.localRetiredEffectLimit) return false;
    effect.retiredAt = now;
    effect.retiredStartLevel = effect.level;
    effect.releaseStartedAt = now;
    effect.releaseLevel = effect.retiredStartLevel;
    effect.target = 0;
    retiredEffects.set(key, effect);
    return true;
  }

  function drawLocal(now, force = false) {
    localFrame = 0;
    if (destroyed) return;
    if (
      !force
      && !reducedMotion.matches
      && lastLocalPaintAt
      && now - lastLocalPaintAt < performanceProfile.localFrameMs
    ) {
      localFrame = requestAnimationFrame(drawLocal);
      return;
    }
    lastLocalPaintAt = now;
    const active = [];
    for (const effect of effects.values()) {
      const delta = Math.min(48, Math.max(1, now - effect.lastFrameAt));
      effect.lastFrameAt = now;
      const distance = pointerPoint
        ? distanceToRect(pointerPoint.x, pointerPoint.y, effect.glyph.rect)
        : Number.POSITIVE_INFINITY;
      const radial = clamp(1 - distance / study.cursorRadius);
      const inside = distance <= study.cursorRadius;
      if (inside) {
        effect.target = clamp(radial * radial, 0.18, 1);
        effect.lastInsideAt = now;
        effect.releaseStartedAt = 0;
        effect.releaseLevel = effect.target;
      } else {
        if (!effect.releaseStartedAt) {
          effect.releaseStartedAt = now;
          effect.releaseLevel = Math.max(effect.level, effect.target);
        }
        const holding = now - effect.releaseStartedAt < study.releaseHoldMs;
        effect.target = holding ? effect.releaseLevel : 0;
      }
      effect.springOmega = effect.target > effect.level ? 23 : (effect.target > 0 ? 16 : study.releaseOmega);
      const spring = criticalSpringState(
        effect.level,
        effect.levelVelocity || 0,
        effect.target,
        delta / 1000,
        effect.springOmega,
      );
      effect.level = clamp(spring.level, 0, 1.15);
      effect.levelVelocity = spring.velocity;
      const releaseComplete = effect.releaseStartedAt
        && now - effect.releaseStartedAt >= study.releaseHoldMs;
      if (releaseComplete && effect.target === 0 && effect.level < 0.002 && Math.abs(effect.levelVelocity) < 0.002) {
        effects.delete(effect.glyph.key);
      } else {
        active.push(effect);
      }
    }
    for (const [key, effect] of retiredEffects) {
      const progress = clamp((now - effect.retiredAt) / LOCAL_RETIRE_MS);
      if (progress >= 1) {
        retiredEffects.delete(key);
        continue;
      }
      const previousLevel = effect.level;
      effect.level = effect.retiredStartLevel * (1 - smoother(progress));
      effect.levelVelocity = (effect.level - previousLevel) / Math.max(0.001, (now - effect.lastFrameAt) / 1000);
      effect.lastFrameAt = now;
      active.push(effect);
    }
    const visible = visibleLocalEffects(
      active,
      performanceProfile.localEffectHardLimit,
    );
    const context = localSurface.context;
    clearLocalDirty();
    localDirtyRects = dirtyRectsForEffects(visible);
    eraseEffectSources(visible);
    for (const effect of visible) {
      drawLocalEffect(context, effect, effect.level, now, study.mode);
    }
    const heldCount = active.filter((effect) => effect.target > 0).length;
    if (active.length !== lastActiveCount) {
      root.dataset.activeFragments = String(active.length);
      lastActiveCount = active.length;
    }
    if (heldCount !== lastHeldCount) {
      root.dataset.heldFragments = String(heldCount);
      lastHeldCount = heldCount;
    }
    const changing = active.some((effect) => (
      Math.abs(effect.target - effect.level) > 0.0005
      || Math.abs(effect.levelVelocity) > 0.002
    ));
    const animatedWhileHeld = LOCAL_DYNAMIC_MODES.has(study.mode)
      && active.some((effect) => (
        effect.target > 0.01
        || (effect.releaseStartedAt && now - effect.releaseStartedAt < study.releaseHoldMs)
      ));
    if (changing || animatedWhileHeld || retiredEffects.size) {
      localFrame = requestAnimationFrame(drawLocal);
    }
  }

  function requestLocalFrame() {
    if (!localFrame) localFrame = requestAnimationFrame(drawLocal);
  }

  function disturb(glyph, now, strength) {
    let existing = effects.get(glyph.key);
    if (!existing && retiredEffects.has(glyph.key)) {
      if (!reserveEffectSlot(
        effects,
        performanceProfile.localEffectSoftLimit,
        performanceProfile.localEffectHardLimit,
        now,
        study.releaseHoldMs,
        retireLocalEffect,
      )) return false;
      existing = retiredEffects.get(glyph.key);
      retiredEffects.delete(glyph.key);
      delete existing.retiredAt;
      delete existing.retiredStartLevel;
      effects.set(glyph.key, existing);
    }
    if (existing) {
      existing.strength = Math.max(existing.strength, strength);
      existing.target = Math.max(existing.target, strength);
      existing.lastInsideAt = now;
      existing.releaseStartedAt = 0;
      existing.releaseLevel = existing.target;
      existing.windX = existing.windX * 0.58 + pointerVelocity.x * 0.42;
      existing.windY = existing.windY * 0.58 + pointerVelocity.y * 0.42;
      requestLocalFrame();
      return true;
    }
    if (!reserveEffectSlot(
      effects,
      performanceProfile.localEffectSoftLimit,
      performanceProfile.localEffectHardLimit,
      now,
      study.releaseHoldMs,
      retireLocalEffect,
    )) return false;
    let points = inkCache.get(glyph.key);
    if (!points && ["latent-diffusion", "fluid-ink", "cellular"].includes(study.mode)) {
      points = sampleGlyphInk(glyph, study.mode === "cellular" ? 74 : 62, inkShapeCache);
      inkCache.set(glyph.key, points);
    }
    effects.delete(glyph.key);
    effects.set(glyph.key, {
      glyph,
      fragments: fragmentLayout(glyph, study.mode, inkShapeCache),
      points: points || [],
      seed: hashString(glyph.key),
      createdAt: now,
      strength,
      level: 0,
      target: strength,
      lastFrameAt: now,
      lastInsideAt: now,
      releaseStartedAt: 0,
      releaseLevel: strength,
      levelVelocity: 0,
      springOmega: 23,
      windX: pointerVelocity.x,
      windY: pointerVelocity.y,
    });
    requestLocalFrame();
    return true;
  }

  function processPoint(
    point,
    now,
    budget,
    visualMemory = null,
    visualBudget = null,
    maxNewAtPoint = 0,
  ) {
    const nearby = nearbyGlyphs(indexes[currentFace], point, study.cursorRadius);
    if (!nearby.length) return;
    audio.brush(
      now,
      clamp(1 - nearby[0].distance / Math.max(1, study.cursorRadius)),
    );
    if (visualMemory && visualBudget) {
      let newAtPoint = 0;
      for (const { glyph, distance } of nearby.slice(
        0,
        performanceProfile.maxVisualGlyphs,
      )) {
        if (visualMemory.has(glyph.key)) continue;
        const existed = effects.has(glyph.key);
        if (!existed && (visualBudget.remaining <= 0 || newAtPoint >= maxNewAtPoint)) continue;
        const radial = 1 - distance / study.cursorRadius;
        if (!disturb(glyph, now, clamp(radial * radial, 0.18, 1))) continue;
        visualMemory.add(glyph.key);
        if (!existed) {
          visualBudget.remaining -= 1;
          newAtPoint += 1;
        }
      }
    }
    const contributionCore = Math.min(28, study.cursorRadius * 0.38);
    for (const { glyph, distance } of nearby) {
      if (distance > contributionCore) continue;
      if (memory.has(glyph.key)) continue;
      if (budget.remaining <= 0) break;
      memory.set(glyph.key, now);
      budget.remaining -= 1;
      addCharge(1);
      // Hovering cleans. The characters under the cursor's core are the ones
      // restored — the wider field is what explodes, so what you see is a
      // scatter of fragments around a cursor that leaves clean text behind it.
      restoreKeys.add(glyph.key);
      audio.tick(now);
    }
  }

  function pointerSamples(event, sampleLimit = MAX_POINTER_SAMPLES) {
    const events = event.getCoalescedEvents?.() || [event];
    const sourceEvents = events.length ? events : [event];
    const maximum = Math.max(
      2,
      Math.floor(Number(sampleLimit) || MAX_POINTER_SAMPLES),
    );

    // Preserve the established laptop path byte-for-byte. Phones instead
    // decimate the raw touch events before interpolation so they never build a
    // dense temporary path only to discard most of it one line later.
    if (maximum < MAX_POINTER_SAMPLES) {
      const endpoint = { x: event.clientX, y: event.clientY };
      const anchors = limitPointerSamples(
        sourceEvents.map((item) => ({ x: item.clientX, y: item.clientY })),
        maximum,
      );
      const lastAnchor = anchors.at(-1);
      if (!lastAnchor || lastAnchor.x !== endpoint.x || lastAnchor.y !== endpoint.y) {
        if (anchors.length >= maximum) anchors[anchors.length - 1] = endpoint;
        else anchors.push(endpoint);
      }

      const output = [];
      for (let index = 0; index < anchors.length && output.length < maximum; index += 1) {
        const target = anchors[index];
        const start = output.at(-1) || lastPoint || target;
        const distance = Math.hypot(target.x - start.x, target.y - start.y);
        const desiredSteps = Math.max(
          1,
          Math.ceil(distance / Math.max(10, study.cursorRadius * 0.28)),
        );
        const remainingAnchors = anchors.length - index - 1;
        const availableSteps = Math.max(
          1,
          maximum - output.length - remainingAnchors,
        );
        const steps = Math.min(desiredSteps, availableSteps);
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          output.push({
            x: start.x + (target.x - start.x) * t,
            y: start.y + (target.y - start.y) * t,
          });
        }
      }
      if (output.length) output[output.length - 1] = endpoint;
      lastPoint = endpoint;
      return output;
    }

    const output = [];
    for (const item of sourceEvents) {
      const target = { x: item.clientX, y: item.clientY };
      const start = output.at(-1) || lastPoint || target;
      const distance = Math.hypot(target.x - start.x, target.y - start.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(10, study.cursorRadius * 0.28)));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        output.push({
          x: start.x + (target.x - start.x) * t,
          y: start.y + (target.y - start.y) * t,
        });
      }
    }
    lastPoint = { x: event.clientX, y: event.clientY };
    return output;
  }

  function onPointerMove(event) {
    const liveHandoff = transitioning && phase === "arming";
    if (destroyed || (!liveHandoff && (transitioning || !inputEnabled))) return;
    if (event.target.closest?.("[data-ui]")) {
      pointerPoint = null;
      midpointPointer = null;
      // Let any samples queued before entering UI commit on their scheduled
      // frame. Clearing them here made a sub-frame pass disappear entirely.
      requestLocalFrame();
      requestMidpointFrame();
      return;
    }
    const pointerNow = performance.now();
    if (lastPoint && lastPointerAt) {
      const elapsed = pointerNow - lastPointerAt;
      if (elapsed > 120) {
        pointerVelocity.x = 0;
        pointerVelocity.y = 0;
      } else {
        const delta = clamp(elapsed, 4, 48);
        const nextX = clamp((event.clientX - lastPoint.x) / delta * 16, -34, 34);
        const nextY = clamp((event.clientY - lastPoint.y) / delta * 16, -34, 34);
        pointerVelocity.x = pointerVelocity.x * 0.52 + nextX * 0.48;
        pointerVelocity.y = pointerVelocity.y * 0.52 + nextY * 0.48;
      }
    }
    lastPointerAt = pointerNow;
    if (phase === "stable" || phase === "arming") {
      if (phase === "stable" && triggered) return;
      pointerPoint = { x: event.clientX, y: event.clientY };
      requestLocalFrame();
    } else if (phase === "midpoint") {
      midpointPointer = { x: event.clientX, y: event.clientY };
      requestMidpointFrame();
    } else {
      return;
    }
    pendingPointerPoints.push(...pointerSamples(
      event,
      performanceProfile.pointerSamples,
    ));
    pendingPointerPoints = limitPointerSamples(
      pendingPointerPoints,
      performanceProfile.pointerSamples,
    );
    if (!pointerFrame) pointerFrame = requestAnimationFrame(flushPointerFrame);
  }

  function flushPointerFrame(now) {
    pointerFrame = 0;
    if (destroyed || (transitioning && phase !== "arming") || !inputEnabled) {
      pendingPointerPoints = [];
      return;
    }
    if (
      (phase === "stable" || phase === "arming")
      && lastPointerFlushAt
      && now - lastPointerFlushAt < performanceProfile.pointerFrameMs
    ) {
      pointerFrame = requestAnimationFrame(flushPointerFrame);
      return;
    }
    if (phase === "stable" || phase === "arming") lastPointerFlushAt = now;
    if (phase === "arming") {
      const points = pendingPointerPoints;
      pendingPointerPoints = [];
      const point = points.at(-1);
      if (point) {
        processPoint(
          point,
          now,
          { remaining: 0 },
          new Set(),
          { remaining: performanceProfile.maxNewVisualsPerFrame },
          performanceProfile.maxNewVisualsPerFrame,
        );
      }
      return;
    }
    if (phase === "midpoint") {
      flushMidpointPointerFrame(now);
      return;
    }
    if (phase !== "stable" || triggered) {
      pendingPointerPoints = [];
      return;
    }
    cleanMemory(now);
    const budget = { remaining: MAX_NEW_PER_FRAME };
    const visualMemory = new Set();
    const points = pendingPointerPoints;
    pendingPointerPoints = [];
    const visualBudget = {
      remaining: effects.size === 0
        ? performanceProfile.maxVisualGlyphs
        : performanceProfile.maxNewVisualsPerFrame,
    };
    // Give the live cursor endpoint first claim, then spend any remaining
    // admissions on the retained coalesced path. Existing effects are always
    // refreshed and never consume the new-effect budget.
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const maxNewAtPoint = points.length === 1
        ? visualBudget.remaining
        : 1;
      processPoint(
        points[index],
        now,
        { remaining: 0 },
        visualMemory,
        visualBudget,
        maxNewAtPoint,
      );
    }
    points.forEach((point) => processPoint(point, now, budget));
    if (charge >= chargeTarget()) {
      triggered = true;
      void transitionToMidpoint();
    }
  }

  function retireMidpointEffect(index, effect, now) {
    if (
      retiredMidpointEffects.size
      >= performanceProfile.midpointRetiredEffectLimit
    ) {
      let oldestRetiredKey = null;
      let oldestRetiredAt = Number.POSITIVE_INFINITY;
      for (const [retiredKey, retiredEffect] of retiredMidpointEffects) {
        if (retiredEffect.retiredAt >= oldestRetiredAt) continue;
        oldestRetiredAt = retiredEffect.retiredAt;
        oldestRetiredKey = retiredKey;
      }
      if (oldestRetiredKey === null) return false;
      retiredMidpointEffects.delete(oldestRetiredKey);
    }
    effect.retiredAt = now;
    effect.retiredStartLevel = effect.level;
    effect.releaseStartedAt = now;
    effect.releaseLevel = effect.retiredStartLevel;
    effect.target = 0;
    retiredMidpointEffects.set(index, effect);
    return true;
  }

  function disturbMidpointToken(entry, point, now, strength) {
    const { index, token, visual } = entry;
    let dx = visual.x - point.x;
    let dy = visual.y - point.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    if (length < 1) {
      const angle = token.seed * TWO_PI;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    } else {
      dx /= length;
      dy /= length;
    }
    let existing = midpointEffects.get(index);
    if (!existing && retiredMidpointEffects.has(index)) {
      if (!reserveEffectSlot(
        midpointEffects,
        performanceProfile.midpointEffectSoftLimit,
        performanceProfile.midpointEffectHardLimit,
        now,
        study.midpointReleaseHoldMs || study.releaseHoldMs,
        retireMidpointEffect,
      )) return false;
      existing = retiredMidpointEffects.get(index);
      retiredMidpointEffects.delete(index);
      delete existing.retiredAt;
      delete existing.retiredStartLevel;
      midpointEffects.set(index, existing);
    }
    if (existing) {
      existing.directionX = dx;
      existing.directionY = dy;
      existing.target = Math.max(existing.target, strength);
      existing.lastInsideAt = now;
      existing.releaseStartedAt = 0;
      existing.releaseLevel = existing.target;
      existing.lastFrameAt = now;
      return true;
    }
    if (!reserveEffectSlot(
      midpointEffects,
      performanceProfile.midpointEffectSoftLimit,
      performanceProfile.midpointEffectHardLimit,
      now,
      study.midpointReleaseHoldMs || study.releaseHoldMs,
      retireMidpointEffect,
    )) return false;
    midpointEffects.set(index, {
      index,
      level: 0,
      target: strength,
      directionX: dx,
      directionY: dy,
      seed: token.seed,
      motif: token.midpointRole,
      phase: hash(index * 13.37),
      // Handedness of this fragment's eddy, fixed for its lifetime.
      curlSign: token.seed > 0.5 ? 1 : -1,
      createdAt: now,
      lastFrameAt: now,
      lastInsideAt: now,
      releaseStartedAt: 0,
      releaseLevel: strength,
      levelVelocity: 0,
      springOmega: 22,
    });
    return true;
  }

  function processMidpointPoint(
    point,
    now,
    budget,
    visualMemory = null,
    visualBudget = null,
    maxNewAtPoint = 0,
    nearbyOverride = null,
  ) {
    if (!activeScene) return;
    const nearby = nearbyOverride || nearbyMidpointTokens(
      activeScene,
      point,
      study.midpointRadius,
      now,
      midpointEffects,
      retiredMidpointEffects,
    );
    if (!nearby.length) return;
    audio.brush(
      now,
      clamp(1 - nearby[0].distance / Math.max(1, study.midpointRadius)),
    );
    if (visualMemory && visualBudget) {
      let newAtPoint = 0;
      for (const entry of nearby.slice(
        0,
        performanceProfile.midpointVisualBurst,
      )) {
        if (visualMemory.has(entry.index)) continue;
        const existed = midpointEffects.has(entry.index);
        if (!existed && (visualBudget.remaining <= 0 || newAtPoint >= maxNewAtPoint)) continue;
        const radial = 1 - entry.distance / study.midpointRadius;
        if (!disturbMidpointToken(entry, point, now, clamp(radial * radial, 0.16, 1))) continue;
        visualMemory.add(entry.index);
        if (!existed) {
          visualBudget.remaining -= 1;
          newAtPoint += 1;
        }
      }
    }
    const contributionCore = Math.min(42, study.midpointRadius * 0.46);
    for (const { index, distance } of nearby) {
      if (distance > contributionCore) continue;
      if (midpointMemory.has(index)) continue;
      if (budget.remaining <= 0) break;
      midpointMemory.set(index, now);
      budget.remaining -= 1;
      addCharge(1);
    }
  }

  function flushMidpointPointerFrame(now) {
    if (
      lastMidpointPointerFlushAt
      && now - lastMidpointPointerFlushAt
        < performanceProfile.midpointActiveFrameMs
    ) {
      pointerFrame = requestAnimationFrame(flushPointerFrame);
      return;
    }
    lastMidpointPointerFlushAt = now;
    cleanMidpointMemory(now);
    const budget = { remaining: MAX_NEW_MIDPOINT_PER_FRAME };
    const points = pendingPointerPoints;
    pendingPointerPoints = [];
    const visualAnchorCache = new Map();
    const nearbyByPoint = points.map((point) => nearbyMidpointTokens(
      activeScene,
      point,
      study.midpointRadius,
      now,
      midpointEffects,
      retiredMidpointEffects,
      visualAnchorCache,
    ));
    const visualMemory = new Set();
    const visualBudget = {
      remaining: midpointEffects.size + retiredMidpointEffects.size === 0
        ? performanceProfile.midpointVisualBurst
        : performanceProfile.maxNewMidpointVisualsPerFrame,
    };
    // The endpoint wins, but a fast swipe that ends in white space can still
    // animate the visible dragon/calligraphy fragments it crossed.
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const maxNewAtPoint = points.length === 1 ? visualBudget.remaining : 1;
      processMidpointPoint(
        points[index],
        now,
        { remaining: 0 },
        visualMemory,
        visualBudget,
        maxNewAtPoint,
        nearbyByPoint[index],
      );
    }
    points.forEach((point, index) => processMidpointPoint(
      point,
      now,
      budget,
      null,
      null,
      0,
      nearbyByPoint[index],
    ));
    requestMidpointFrame();
    if (charge >= chargeTarget() && !transitioning) {
      void resolveMidpoint();
    }
  }

  function drawMidpoint(now) {
    midpointFrame = 0;
    if (destroyed || phase !== "midpoint" || !activeScene) return;
    const equilibriumAlive = activeScene.passiveMidpointMotion && !reducedMotion.matches;
    const frameInterval = midpointEffects.size || retiredMidpointEffects.size
      ? performanceProfile.midpointActiveFrameMs
      : performanceProfile.midpointIdleFrameMs;
    if (
      (equilibriumAlive || midpointEffects.size > 0 || retiredMidpointEffects.size > 0)
      && now - lastMidpointPaintAt < frameInterval
    ) {
      midpointFrame = requestAnimationFrame(drawMidpoint);
      return;
    }
    // B6 — advance the pointer-seeking component once per frame, before any
    // fragment reads it, so the whole body turns off a single shared vector.
    const swimDelta = lastSwimAt ? Math.min(0.1, (now - lastSwimAt) / 1000) : 0.016;
    lastSwimAt = now;
    advanceSwim(activeScene, midpointPointer, activeScene.swimOrigin, swimDelta);

    lastMidpointPaintAt = now;
    const active = [];
    for (const [index, effect] of midpointEffects) {
      const delta = Math.min(48, Math.max(1, now - effect.lastFrameAt));
      effect.lastFrameAt = now;
      const token = activeScene.tokens[index];
      const visual = token
        ? midpointVisualAnchor(
            activeScene,
            token,
            index,
            now,
            midpointEffects,
            retiredMidpointEffects,
          )
        : null;
      const distance = midpointPointer && token
        ? Math.hypot(midpointPointer.x - visual.x, midpointPointer.y - visual.y)
        : Number.POSITIVE_INFINITY;
      const radial = clamp(1 - distance / study.midpointRadius);
      const inside = distance <= study.midpointRadius;
      const releaseHold = study.midpointReleaseHoldMs || study.releaseHoldMs;
      if (inside) {
        effect.target = clamp(radial * radial, 0.14, 1);
        effect.lastInsideAt = now;
        effect.releaseStartedAt = 0;
        effect.releaseLevel = effect.target;
      } else {
        if (!effect.releaseStartedAt) {
          effect.releaseStartedAt = now;
          effect.releaseLevel = Math.max(effect.level, effect.target);
        }
        effect.target = now - effect.releaseStartedAt < releaseHold ? effect.releaseLevel : 0;
      }
      effect.springOmega = effect.target > effect.level
        ? 22
        : (effect.target > 0 ? 15 : (study.midpointReleaseOmega || study.releaseOmega));
      const spring = criticalSpringState(
        effect.level,
        effect.levelVelocity || 0,
        effect.target,
        delta / 1000,
        effect.springOmega,
      );
      effect.level = clamp(spring.level, 0, 1.15);
      effect.levelVelocity = spring.velocity;
      const releaseComplete = effect.releaseStartedAt && now - effect.releaseStartedAt >= releaseHold;
      if (releaseComplete && effect.target === 0 && effect.level < 0.002 && Math.abs(effect.levelVelocity) < 0.002) {
        midpointEffects.delete(index);
      } else active.push(effect);
    }
    for (const [index, effect] of retiredMidpointEffects) {
      const progress = clamp((now - effect.retiredAt) / MIDPOINT_RETIRE_MS);
      if (progress >= 1) {
        retiredMidpointEffects.delete(index);
        continue;
      }
      const previousLevel = effect.level;
      effect.level = effect.retiredStartLevel * (1 - smoother(progress));
      effect.levelVelocity = (effect.level - previousLevel)
        / Math.max(0.001, (now - effect.lastFrameAt) / 1000);
      effect.lastFrameAt = now;
      active.push(effect);
    }
    renderTransition(
      globalSurface.context,
      activeScene,
      MIDPOINT_PROGRESS,
      now,
      {
        midpointEffects,
        retiredMidpointEffects,
        offsetScale: 1,
        allowPassive: !reducedMotion.matches,
        flash: flashLevel(now),
      },
    );
    const held = active.filter((effect) => effect.target > 0).length;
    if (root.dataset.midpointActive !== String(active.length)) root.dataset.midpointActive = String(active.length);
    if (root.dataset.midpointHeld !== String(held)) root.dataset.midpointHeld = String(held);
    const changing = active.some((effect) => (
      Math.abs(effect.target - effect.level) > 0.0005
      || Math.abs(effect.levelVelocity) > 0.002
    ));
    const animatedWhileHeld = MIDPOINT_DYNAMIC_MODES.has(study.mode)
      && active.some((effect) => (
        effect.target > 0.01
        || (
          effect.releaseStartedAt
          && now - effect.releaseStartedAt < (study.midpointReleaseHoldMs || study.releaseHoldMs)
        )
      ));
    if (
      changing
      || animatedWhileHeld
      || retiredMidpointEffects.size
      || equilibriumAlive
      || flashLevel(now) > 0.002
    ) {
      midpointFrame = requestAnimationFrame(drawMidpoint);
    }
  }

  // E19 — one attack, one decay, and then the page is monochrome again for the
  // rest of its life.
  function flashLevel(now) {
    if (!flashStartedAt) return 0;
    const elapsed = now - flashStartedAt;
    if (elapsed < 0) return 0;
    if (elapsed >= FLASH_ATTACK_MS + FLASH_DECAY_MS) {
      flashStartedAt = 0;
      return 0;
    }
    if (elapsed < FLASH_ATTACK_MS) return smoother(elapsed / FLASH_ATTACK_MS);
    return 1 - smoother((elapsed - FLASH_ATTACK_MS) / FLASH_DECAY_MS);
  }

  function requestMidpointFrame() {
    if (phase === "midpoint" && !midpointFrame) midpointFrame = requestAnimationFrame(drawMidpoint);
  }

  function applyFace(face) {
    layers.forEach((layer, index) => {
      const active = index === face;
      layer.dataset.active = active ? "true" : "false";
      layer.setAttribute("aria-hidden", active ? "false" : "true");
      layer.inert = !active;
    });
    aging?.setFace(face);
    root.dataset.face = face ? "b" : "a";
    delete root.dataset.midpointVariant;
  }

  function resetLocal() {
    effects.clear();
    retiredEffects.clear();
    memory.clear();
    charge = 0;
    lastDrainAt = 0;
    updateProgress();
    triggered = false;
    lastPoint = null;
    lastPointerAt = 0;
    lastPointerFlushAt = 0;
    lastLocalPaintAt = 0;
    pointerVelocity = { x: 0, y: 0 };
    pointerPoint = null;
    clearLocalDirty();
    localSurface.context.clearRect(0, 0, localSurface.width, localSurface.height);
    root.dataset.activeFragments = "0";
    root.dataset.heldFragments = "0";
    lastActiveCount = 0;
    lastHeldCount = 0;
    lastProgressText = "";
    updateProgress();
  }

  function resetMidpoint() {
    midpointEffects.clear();
    retiredMidpointEffects.clear();
    midpointMemory.clear();
    charge = 0;
    lastDrainAt = 0;
    updateProgress();
    midpointPointer = null;
    lastSwimAt = 0;
    lastMidpointPointerFlushAt = 0;
    if (midpointFrame) cancelAnimationFrame(midpointFrame);
    midpointFrame = 0;
    lastMidpointPaintAt = 0;
    root.dataset.midpointActive = "0";
    root.dataset.midpointHeld = "0";
    lastProgressText = "";
  }

  function invalidateScenes() {
    sceneGeneration += 1;
    atlasCache = [null, null];
    chromeCache = [null, null];
    sceneCache.clear();
    scenePromises.clear();
  }

  function sceneKey(sourceFace, midpointKind) {
    return `${sourceFace}:${midpointKind}`;
  }

  function buildScene(sourceFace, midpointKind = midpointVariants[0].id) {
    const targetFace = sourceFace ? 0 : 1;
    if (!atlasCache[sourceFace]) {
      atlasCache[sourceFace] = rasterLayer(
        captures[sourceFace],
        layers[sourceFace],
        globalSurface.width,
        globalSurface.height,
        globalSurface.dpr,
      );
    }
    if (!atlasCache[targetFace]) {
      atlasCache[targetFace] = rasterLayer(
        captures[targetFace],
        layers[targetFace],
        globalSurface.width,
        globalSurface.height,
        globalSurface.dpr,
      );
    }
    if (!chromeCache[sourceFace]) {
      chromeCache[sourceFace] = rasterChrome(
        layers[sourceFace],
        globalSurface.width,
        globalSurface.height,
        globalSurface.dpr,
      );
    }
    if (!chromeCache[targetFace]) {
      chromeCache[targetFace] = rasterChrome(
        layers[targetFace],
        globalSurface.width,
        globalSurface.height,
        globalSurface.dpr,
      );
    }
    const tokens = makeTransitionTokens(
      captures[sourceFace],
      captures[targetFace],
      study,
      globalSurface.width,
      globalSurface.height,
      inkShapeCache,
      midpointMask,
      midpointKind,
      quality.tokenLimit,
    );
    const bounds = midpointBounds(tokens, globalSurface.width, globalSurface.height);
    const passiveMidpointMotion = (
      study.passiveMidpointMotion
      && performanceProfile.passiveMidpointMotion
    );
    if (passiveMidpointMotion) preparePassiveMidpoint(tokens, bounds);
    return {
      ...globalSurface,
      study,
      sourceAtlas: atlasCache[sourceFace],
      targetAtlas: atlasCache[targetFace],
      sourceChromeAtlas: chromeCache[sourceFace],
      targetChromeAtlas: chromeCache[targetFace],
      tokens,
      midpointKind,
      midpointLabel: midpointVariants.find(({ id }) => id === midpointKind)?.label || study.midpointName || "龍",
      hasCalligraphy: tokens.some((token) => token.midpointRole === "calligraphy"),
      passiveMidpointMotion,
      rotatingTokenStride: performanceProfile.rotatingTokenStride,
      // B6 seeks the pointer relative to the formation's own centre.
      swimOrigin: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
      swim: { x: 0, y: 0 },
      midpointBounds: bounds,
      baseTokenCount: tokens.length,
      handoffRects: [],
      midpointIndex: midpointSpatialIndex(tokens),
    };
  }

  function refreshSceneTargetAtlas(scene, targetFace) {
    const atlas = rasterLayer(
      captures[targetFace],
      layers[targetFace],
      globalSurface.width,
      globalSurface.height,
      globalSurface.dpr,
    );
    atlasCache[targetFace] = atlas;
    scene.targetAtlas = atlas;
  }

  function scheduleScene(sourceFace, midpointKind = midpointVariants[0].id) {
    const key = sceneKey(sourceFace, midpointKind);
    if (sceneCache.has(key)) return Promise.resolve(sceneCache.get(key));
    if (scenePromises.has(key)) return scenePromises.get(key);
    const generation = sceneGeneration;
    const promise = new Promise((resolve) => {
      const run = () => {
        if (destroyed || generation !== sceneGeneration) {
          resolve(null);
          return;
        }
        if (sceneCache.has(key)) {
          resolve(sceneCache.get(key));
          return;
        }
        const scene = buildScene(sourceFace, midpointKind);
        sceneCache.set(key, scene);
        resolve(scene);
      };
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(run, { timeout: 1200 });
      } else {
        setTimeout(run, 320);
      }
    }).finally(() => {
      if (scenePromises.get(key) === promise) scenePromises.delete(key);
    });
    scenePromises.set(key, promise);
    return promise;
  }

  function prewarmQueuedScene(sourceFace) {
    void scheduleScene(sourceFace, queuedMidpoint.id);
  }

  function rebuildCaptures(resizeCanvases = false, preserveProgress = false) {
    pendingCapture = false;
    const disturbanceProgress = quality.tier === "mobile" && phase === "stable"
      ? clamp(charge / Math.max(1, chargeTarget()), 0, 1.05)
      : null;
    if (preserveProgress) clearLocalDirty();
    if (resizeCanvases) {
      globalSurface = setupCanvas(globalCanvas, quality.globalDprCap);
      localSurface = setupCanvas(localCanvas, quality.localDprCap);
      fitFaces();
      aging?.remeasure();
    }
    captures = layers.map((layer) => captureLayer(
      layer,
      localSurface.context,
      performanceProfile.imageTileTarget,
    ));
    captureReferenceCounts = captures.map(captureReferenceParticleCount);
    indexes = captures.map(spatialIndex);
    captureMaps = captures.map(
      (glyphs) => new Map(glyphs.map((glyph) => [glyph.key, glyph])),
    );
    // A fresh measurement already includes every ageing offset, so the nudges
    // this would otherwise have to replay are now redundant.
    agingDirty = false;
    scrollPositions = layers.map((layer) => layer.querySelector(".default-page")?.scrollTop || 0);
    invalidateScenes();
    if (preserveProgress) {
      const glyphsByKey = new Map(captures[currentFace].map((glyph) => [glyph.key, glyph]));
      for (const collection of [effects, retiredEffects]) {
        for (const [key, effect] of collection) {
          const glyph = glyphsByKey.get(key);
          if (!glyph) {
            collection.delete(key);
            continue;
          }
          effect.glyph = glyph;
          effect.fragments = fragmentLayout(glyph, study.mode, inkShapeCache);
        }
      }
      requestLocalFrame();
    } else {
      resetLocal();
    }
    if (disturbanceProgress !== null) {
      charge = disturbanceProgress * chargeTarget();
      lastProgressText = "";
      updateProgress();
    }
    prewarmQueuedScene(currentFace);
  }

  function rebuildMidpointSceneForResize() {
    if (!activeScene || phase !== "midpoint" || transitioning) return;
    const midpointKind = activeScene.midpointKind;
    const disturbanceProgress = clamp(
      charge / Math.max(1, chargeTarget()),
      0,
      1.05,
    );
    if (midpointFrame) cancelAnimationFrame(midpointFrame);
    midpointFrame = 0;
    globalSurface = setupCanvas(globalCanvas, quality.globalDprCap);
    localSurface = setupCanvas(localCanvas, quality.localDprCap);
    fitFaces();
    aging?.remeasure();
    captures = layers.map((layer) => captureLayer(
      layer,
      localSurface.context,
      performanceProfile.imageTileTarget,
    ));
    captureReferenceCounts = captures.map(captureReferenceParticleCount);
    indexes = captures.map(spatialIndex);
    captureMaps = captures.map(
      (glyphs) => new Map(glyphs.map((glyph) => [glyph.key, glyph])),
    );
    // A fresh measurement already includes every ageing offset, so the nudges
    // this would otherwise have to replay are now redundant.
    agingDirty = false;
    scrollPositions = layers.map((layer) => layer.querySelector(".default-page")?.scrollTop || 0);
    invalidateScenes();
    const scene = buildScene(currentFace, midpointKind);
    sceneCache.set(sceneKey(currentFace, midpointKind), scene);
    activeScene = scene;
    charge = disturbanceProgress * chargeTarget();
    lastProgressText = "";
    updateProgress();
    // Token indices are assigned by a viewport-dependent stratified sample.
    // After a resize the same index may describe a different particle, so
    // carrying index-keyed memory or effects across would attach the old
    // interaction to the wrong fragment.
    midpointEffects.clear();
    retiredMidpointEffects.clear();
    midpointMemory.clear();
    lastMidpointPaintAt = 0;
    lastMidpointPointerFlushAt = 0;
    pendingResize = false;
    renderTransition(
      globalSurface.context,
      activeScene,
      MIDPOINT_PROGRESS,
      performance.now(),
      {
        midpointEffects,
        retiredMidpointEffects,
        offsetScale: 1,
        allowPassive: !reducedMotion.matches,
      },
    );
    requestMidpointFrame();
  }

  function animateProgress(scene, from, to, duration, useMidpointOffsets = false) {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      let lastPaintAt = 0;
      const tick = (now) => {
        globalFrame = 0;
        const elapsed = reducedMotion.matches ? 1 : clamp((now - startedAt) / duration);
        if (
          elapsed < 1
          && lastPaintAt
          && performanceProfile.transitionFrameMs > 0
          && now - lastPaintAt < performanceProfile.transitionFrameMs
        ) {
          globalFrame = requestAnimationFrame(tick);
          return;
        }
        lastPaintAt = now;
        // tokenPose already eases each physical leg. Keeping the timeline linear
        // avoids a second ease that previously looked like a one-second freeze.
        const progress = from + (to - from) * elapsed;
        const offsetScale = useMidpointOffsets
          ? 1 - smoother(clamp((progress - MIDPOINT_PROGRESS) / 0.14))
          : 0;
        renderTransition(
          globalSurface.context,
          scene,
          progress,
          now,
          {
            midpointEffects: useMidpointOffsets ? midpointEffects : null,
            retiredMidpointEffects: useMidpointOffsets ? retiredMidpointEffects : null,
            offsetScale,
            flash: flashLevel(now),
          },
        );
        if (quality.sample(now)) {
          // The machine could not hold the full budget. Everything cached was
          // built to it, so it all has to go; the transition in flight keeps
          // its scene and the next one is built smaller.
          invalidateScenes();
          root.dataset.quality = quality.tier;
        }
        if (elapsed >= 1 || destroyed) {
          quality.endSample();
          resolve();
        } else globalFrame = requestAnimationFrame(tick);
      };
      globalFrame = requestAnimationFrame(tick);
    });
  }

  function refreshPendingCapture(sourceFace, midpointKind) {
    if (!pendingCapture) return null;
    clearTimeout(scrollTimer);
    rebuildCaptures(false, true);
    const scene = buildScene(sourceFace, midpointKind);
    sceneCache.set(sceneKey(sourceFace, midpointKind), scene);
    return scene;
  }

  async function transitionToMidpoint() {
    if (transitioning || destroyed || phase !== "stable") return;
    // Lock the dial immediately, then let any final text/photo work converge in
    // bounded frames before the page is captured for the attractor.
    transitioning = true;
    syncClockControl();
    endClockDrag({
      reconcile: true,
      resumeAging: false,
      scheduleCapture: false,
    });
    if (clockReconciling) {
      await reconcileClockAge({
        resumeAging: false,
        scheduleCapture: false,
      });
    }
    if (destroyed || phase !== "stable") return;
    flushClockCaptureSync({ allowTransition: true });
    phase = "arming";
    inputEnabled = !reducedMotion.matches;
    root.dataset.phase = phase;
    syncClockControl();
    const targetFace = currentFace ? 0 : 1;
    const semantic = root.querySelector(".semantic-pages");
    // The DOM page is about to go behind the canvas. The clock keeps running
    // in there, but there is no point restyling letters nobody can see.
    aging?.setActive(false);
    if (semantic?.contains(document.activeElement)) root.focus({ preventScroll: true });
    if (reducedMotion.matches) {
      resetCellState();
      currentFace = targetFace;
      applyFace(currentFace);
      resetLocal();
      phase = "stable";
      root.dataset.phase = phase;
      transitioning = false;
      aging?.setActive(true);
      syncClockControl();
      return;
    }

    const chosenMidpoint = queuedMidpoint;
    const midpointKind = chosenMidpoint.id;
    refreshPendingCapture(currentFace, midpointKind);
    let scene = await scheduleScene(currentFace, midpointKind);
    scene = refreshPendingCapture(currentFace, midpointKind) || scene;
    if (!scene && !destroyed) {
      scene = buildScene(currentFace, midpointKind);
      sceneCache.set(sceneKey(currentFace, midpointKind), scene);
    }
    if (!scene || destroyed) return;
    activeScene = scene;
    root.dataset.transitionTokens = String(scene.baseTokenCount);
    phase = "assembling";
    inputEnabled = false;
    root.dataset.phase = phase;
    syncClockControl();

    await new Promise((resolve) => {
      requestAnimationFrame((now) => {
        if (localFrame) cancelAnimationFrame(localFrame);
        localFrame = 0;
        drawLocal(now, true);
        if (localFrame) cancelAnimationFrame(localFrame);
        localFrame = 0;
        const handoffEffects = new Map(
          visibleLocalEffects(
            [...retiredEffects.values(), ...effects.values()],
            performanceProfile.localEffectHardLimit,
          )
            .map((effect) => [effect.glyph.key, effect]),
        );
        seedSceneHandoff(scene, handoffEffects, now, study);
        renderTransition(globalSurface.context, scene, 0, now);
        root.dataset.handoff = "commit";
        root.dataset.owner = "canvas";
        semantic?.setAttribute("aria-hidden", "true");
        if (semantic) semantic.inert = true;
        resolve();
      });
    });
    await new Promise((resolve) => requestAnimationFrame(() => {
      delete root.dataset.handoff;
      resolve();
    }));
    if (destroyed) return;
    // The cell changes state on the way *in*. The scene was captured from the
    // aged page a moment ago, so the dragon still carries the wear; the page
    // behind the canvas is restored now and the hand winds back to twelve in
    // full view, because the clock is not part of the canvas.
    resetCellState();
    // Photo reset happens after scene prewarming. Refresh only the target
    // endpoint so progress 1 matches the now-clean DOM page; the frozen source
    // atlas must keep the damage that seeded the attractor.
    refreshSceneTargetAtlas(scene, targetFace);
    effects.clear();
    retiredEffects.clear();
    pointerPoint = null;
    clearLocalDirty();
    localSurface.context.clearRect(0, 0, localSurface.width, localSurface.height);
    await animateProgress(scene, 0, MIDPOINT_PROGRESS, study.durationMs);
    if (destroyed) return;
    // The fragments have arrived. This is the one moment the page is allowed a
    // colour, and it is over in half a second.
    flashStartedAt = performance.now();
    audio.arrival();
    renderTransition(globalSurface.context, scene, MIDPOINT_PROGRESS, performance.now(), {
      flash: flashLevel(performance.now()),
    });
    resetMidpoint();
    lastPoint = null;
    pendingPointerPoints = [];
    phase = "midpoint";
    root.dataset.phase = phase;
    root.dataset.midpointVariant = scene.midpointKind;
    transitioning = false;
    inputEnabled = !reducedMotion.matches;
    syncClockControl();
    updateProgress();
    requestMidpointFrame();
  }

  async function resolveMidpoint() {
    if (transitioning || destroyed || phase !== "midpoint" || !activeScene) return;
    transitioning = true;
    phase = "resolving";
    inputEnabled = false;
    root.dataset.phase = phase;
    syncClockControl();
    midpointPointer = null;
    if (midpointFrame) cancelAnimationFrame(midpointFrame);
    midpointFrame = 0;
    const scene = activeScene;
    const targetFace = currentFace ? 0 : 1;

    await animateProgress(scene, MIDPOINT_PROGRESS, 1, study.resolveMs, true);
    if (destroyed) return;

    currentFace = targetFace;
    applyFace(currentFace);
    resetMidpoint();
    resetLocal();
    activeScene = null;
    const semantic = root.querySelector(".semantic-pages");
    await twoFrames();
    semantic?.removeAttribute("aria-hidden");
    if (semantic) semantic.inert = false;
    root.dataset.owner = "returning";
    await waitForOpacityTransition(globalCanvas);
    globalSurface.context.clearRect(0, 0, globalSurface.width, globalSurface.height);
    root.dataset.owner = "dom";
    phase = "stable";
    root.dataset.phase = phase;
    transitioning = false;
    inputEnabled = !reducedMotion.matches;
    aging?.setActive(true);
    syncClockControl();
    lastProgressText = "";
    updateProgress();
    queuedMidpoint = chooseMidpointVariant(midpointVariants);
    if (pendingResize) {
      pendingResize = false;
      rebuildCaptures(true);
    } else {
      prewarmQueuedScene(currentFace);
    }
  }

  // Keyboard equivalent of filling the meter. Without it the attractor would
  // be unreachable for anyone not using a pointer.
  function resetCellState() {
    if (!aging) return;
    const from = aging.state || {
      elapsed: 0,
      seconds: 0,
      turns: 0,
      corrupted: 0,
    };
    rewindingAge = true;
    syncClockControl();
    aging.reset();
    photos.reset();
    agingDirty = true;
    audio.restore();
    if (reducedMotion.matches) {
      rewindingAge = false;
      clock?.removeAttribute("data-rewind");
      updateAgeReadout();
      syncClockControl();
      return;
    }
    const rewindMs = Math.min(
      CLOCK_REWIND_MAX_MS,
      CLOCK_REWIND_BASE_MS + from.turns * CLOCK_REWIND_PER_TURN_MS,
    );
    if (clock) clock.dataset.rewind = "true";
    // The readout counts down alongside the hand. Letting the ageing tick
    // publish it instead would step it in half-second jumps.
    const startedAt = performance.now();
    let lastTitleStep = -1;
    const step = (now) => {
      const progress = clamp((now - startedAt) / rewindMs);
      const remaining = 1 - smoother(progress);
      const elapsed = from.elapsed * remaining;
      clock?.style.setProperty("--hand-age", (from.turns * 360 * remaining).toFixed(2));
      root.dataset.age = (from.turns * remaining).toFixed(3);
      const titleStep = Math.ceil(remaining * 4);
      if (titleStep !== lastTitleStep) {
        lastTitleStep = titleStep;
        corruptTitle((from.corrupted || 0) * remaining);
      }
      favicon.setElapsed(elapsed, { recovering: true });
      writeAgeLine(from.seconds * remaining);
      if (progress < 1 && !destroyed) {
        countdownFrame = requestAnimationFrame(step);
      } else {
        countdownFrame = 0;
        rewindingAge = false;
        clock?.removeAttribute("data-rewind");
        updateAgeReadout();
        syncClockControl();
      }
    };
    if (countdownFrame) cancelAnimationFrame(countdownFrame);
    countdownFrame = requestAnimationFrame(step);
  }

  function onAdvance() {
    if (phase === "midpoint") void resolveMidpoint();
    else if (phase === "stable") void transitionToMidpoint();
  }

  // The glyph never changes; the state is carried by aria-pressed, which the
  // stylesheet also uses to strike it through. A combining slash on the note
  // renders differently on every platform and often not at all.
  function syncSoundButton() {
    if (!soundButton) return;
    const status = audio.status;
    const active = status.ready || status.activating;
    soundButton.setAttribute("aria-pressed", active ? "true" : "false");
    soundButton.setAttribute(
      "aria-label",
      status.enabled
        ? status.ready
          ? "Disable sound"
          : status.activating
            ? "Cancel sound activation"
            : "Start sound"
        : "Enable sound",
    );
    soundButton.dataset.state = status.enabled && !active ? "locked" : status.state;
  }

  async function onSoundButton() {
    const status = audio.status;
    if (status.enabled && (status.ready || status.activating)) {
      audio.setEnabled(false);
      syncSoundButton();
      return;
    }
    // Freshly enabled and remembered-but-locked sound use one activation path.
    // unlock() primes and resumes audio while this trusted click is active,
    // then plays exactly one audible paper preview.
    const enabled = audio.setEnabled(true);
    syncSoundButton();
    if (enabled) {
      const activation = audio.unlock({ feedback: true });
      syncSoundButton();
      await activation;
      syncSoundButton();
    }
  }

  function unlockRememberedAudio() {
    if (!audio.enabled || audio.ready) return;
    const activation = audio.unlock();
    syncSoundButton();
    void activation.then(syncSoundButton);
  }

  function onPointerDown(event) {
    // A remembered preference still needs one trusted gesture after a reload.
    // Start resume() before yielding to the animation-frame pointer pipeline.
    if (!event.target.closest?.("[data-ui]")) unlockRememberedAudio();
    onPointerMove(event);
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (destroyed) return;
      if (!transitioning && phase === "midpoint" && activeScene) {
        rebuildMidpointSceneForResize();
        // The midpoint rebuild fits the hidden pages too, but a resize that
        // lands mid-transition would otherwise be swallowed entirely and leave
        // the type at the size it was fitted for on the previous viewport.
        pendingResize = true;
        return;
      }
      if (transitioning || phase !== "stable") {
        pendingResize = true;
        return;
      }
      rebuildCaptures(true);
    }, 160);
  }

  function onLayoutChange(event) {
    if (phase !== "stable" && phase !== "arming") {
      if (root.dataset.owner === "returning") pendingResize = true;
      return;
    }
    pendingCapture = true;
    const page = event.target?.closest?.(".default-page");
    if (page) {
      const face = layers.findIndex((layer) => layer.contains(page));
      if (face >= 0) {
        const nextScroll = page.scrollTop;
        const deltaY = scrollPositions[face] - nextScroll;
        if (Math.abs(deltaY) > 0.01) {
          clearLocalDirty();
          for (const glyph of captures[face]) {
            glyph.rect.top += deltaY;
            glyph.rect.bottom += deltaY;
            glyph.baseline += deltaY;
            if (glyph.imageGroupRect) {
              glyph.imageGroupRect.top += deltaY;
              glyph.imageGroupRect.bottom += deltaY;
            }
          }
          indexes[face] = spatialIndex(captures[face]);
          scrollPositions[face] = nextScroll;
          if (face === currentFace) {
            for (const collection of [effects, retiredEffects]) {
              for (const effect of collection.values()) {
                for (const fragment of effect.fragments) fragment.y += deltaY;
              }
            }
            invalidateScenes();
          }
          requestLocalFrame();
        }
      }
    }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (destroyed) return;
      if (phase === "arming") return;
      if (transitioning) {
        pendingResize = true;
        return;
      }
      rebuildCaptures(false, true);
    }, 90);
  }

  function onMotionPreference() {
    inputEnabled = !reducedMotion.matches && !transitioning;
    if (reducedMotion.matches) {
      if (countdownFrame) cancelAnimationFrame(countdownFrame);
      countdownFrame = 0;
      if (rewindingAge) {
        rewindingAge = false;
        clock?.removeAttribute("data-rewind");
        updateAgeReadout();
      }
      aging?.stop();
    } else {
      if (
        !clockDragging
        && !clockReconciling
        && phase === "stable"
        && !transitioning
      ) aging?.setActive(true);
      aging?.start();
    }
    if (reducedMotion.matches && phase === "stable") resetLocal();
    if (phase === "midpoint" && activeScene) {
      if (reducedMotion.matches) {
        if (midpointFrame) cancelAnimationFrame(midpointFrame);
        midpointFrame = 0;
        midpointEffects.clear();
        retiredMidpointEffects.clear();
        midpointPointer = null;
        renderTransition(
          globalSurface.context,
          activeScene,
          MIDPOINT_PROGRESS,
          performance.now(),
          { allowPassive: false },
        );
        root.dataset.midpointActive = "0";
        root.dataset.midpointHeld = "0";
      } else {
        requestMidpointFrame();
      }
    }
    syncClockControl();
  }

  const onPointerLeave = () => {
    lastPoint = null;
    lastPointerAt = 0;
    pointerVelocity = { x: 0, y: 0 };
    pointerPoint = null;
    midpointPointer = null;
    // Preserve the last queued sample. It can create its visual one frame
    // later with no live pointer, then immediately follow the normal linger.
    requestLocalFrame();
    requestMidpointFrame();
  };
  const onTransientScrollInput = (event) => {
    if (event.type === "wheel") {
      audio.rustle(
        performance.now(),
        Math.min(1, Math.abs(event.deltaY || event.deltaX || 0) / 120),
      );
    }
    if (
      (transitioning && root.dataset.owner === "dom")
      || root.dataset.owner === "returning"
    ) event.preventDefault();
  };
  const memoryTimer = setInterval(() => {
    const now = performance.now();
    if (phase === "midpoint") cleanMidpointMemory(now);
    else if (phase === "stable") cleanMemory(now);
    drainCharge(now);
    refreshLiveAge();
    if (restoreKeys.size) {
      aging?.restore(restoreKeys);
      if (photos.restore(restoreKeys)) agingDirty = true;
      restoreKeys.clear();
    }
    if (
      !clockDragging
      && !clockReconciling
      && (
        quality.tier !== "mobile"
        || (phase === "stable" && root.dataset.owner === "dom")
      )
    ) photos.churn();
    scheduleAgingSync();
  }, 250);
  root.addEventListener("pointermove", onPointerMove, { passive: true });
  root.addEventListener("pointerdown", onPointerDown, { passive: true });
  root.addEventListener("click", unlockRememberedAudio);
  root.addEventListener("keydown", unlockRememberedAudio);
  root.addEventListener("pointerleave", onPointerLeave, { passive: true });
  root.addEventListener("pointercancel", onPointerLeave, { passive: true });
  root.addEventListener("wheel", onTransientScrollInput, { passive: false });
  root.addEventListener("touchmove", onTransientScrollInput, { passive: false });
  root.addEventListener("scroll", onLayoutChange, { capture: true, passive: true });
  root.addEventListener("toggle", onLayoutChange, true);
  root.addEventListener("loong:advance", onAdvance);
  soundButton?.addEventListener("click", onSoundButton);
  clockControl?.addEventListener("pointerdown", onClockPointerDown);
  clockControl?.addEventListener("pointermove", onClockPointerMove);
  clockControl?.addEventListener("pointerup", onClockPointerEnd);
  clockControl?.addEventListener("pointercancel", onClockPointerCancel);
  clockControl?.addEventListener("lostpointercapture", onClockLostPointerCapture);
  clockControl?.addEventListener("keydown", onClockKeyDown);
  window.addEventListener("resize", onResize, { passive: true });
  // `window.resize` misses the case that matters most here: a page that mounted
  // while its container had no size at all and only later got one.
  const resizeObserver = new ResizeObserver(() => onResize());
  resizeObserver.observe(root);
  reducedMotion.addEventListener("change", onMotionPreference);
  root.dataset.owner = "dom";
  root.dataset.quality = quality.tier;
  root.dataset.phase = "stable";
  root.dataset.radius = String(study.cursorRadius);
  root.dataset.activeFragments = "0";
  root.dataset.heldFragments = "0";
  root.dataset.midpointActive = "0";
  root.dataset.midpointHeld = "0";
  applyFace(0);
  updateProgress();
  syncSoundButton();
  syncClockControl();
  if (!reducedMotion.matches) {
    prewarmQueuedScene(0);
    aging?.setActive(true);
    aging?.start();
  }

  return () => {
    endClockDrag({
      reconcile: false,
      resumeAging: false,
      scheduleCapture: false,
    });
    pauseClockReconciliation();
    clearClockSyncHold();
    clockReconciling = false;
    resolveClockReconcile?.();
    resolveClockReconcile = null;
    destroyed = true;
    clearInterval(memoryTimer);
    clearTimeout(resizeTimer);
    clearTimeout(scrollTimer);
    clearTimeout(agingSyncTimer);
    clearTimeout(clockCaptureTimer);
    if (countdownFrame) cancelAnimationFrame(countdownFrame);
    clock?.removeAttribute("data-rewind");
    aging?.destroy();
    photos.destroy();
    audio.destroy();
    favicon.destroy();
    if (localFrame) cancelAnimationFrame(localFrame);
    if (globalFrame) cancelAnimationFrame(globalFrame);
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    if (midpointFrame) cancelAnimationFrame(midpointFrame);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("click", unlockRememberedAudio);
    root.removeEventListener("keydown", unlockRememberedAudio);
    root.removeEventListener("pointerleave", onPointerLeave);
    root.removeEventListener("pointercancel", onPointerLeave);
    root.removeEventListener("wheel", onTransientScrollInput);
    root.removeEventListener("touchmove", onTransientScrollInput);
    root.removeEventListener("scroll", onLayoutChange, true);
    root.removeEventListener("toggle", onLayoutChange, true);
    root.removeEventListener("loong:advance", onAdvance);
    soundButton?.removeEventListener("click", onSoundButton);
    clockControl?.removeEventListener("pointerdown", onClockPointerDown);
    clockControl?.removeEventListener("pointermove", onClockPointerMove);
    clockControl?.removeEventListener("pointerup", onClockPointerEnd);
    clockControl?.removeEventListener("pointercancel", onClockPointerCancel);
    clockControl?.removeEventListener("lostpointercapture", onClockLostPointerCapture);
    clockControl?.removeEventListener("keydown", onClockKeyDown);
    window.removeEventListener("resize", onResize);
    resizeObserver.disconnect();
    reducedMotion.removeEventListener("change", onMotionPreference);
  };
}
