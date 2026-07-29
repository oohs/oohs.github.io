const SIZE = 32;
const FRAME_MS = 160;
const RECOVERY_PAINT_MS = 160;
const AGE_CONSTANT_MS = 46000;
const SLICE_ROWS = [9, 16, 23];
const ACTIVATION_ORDER = [1, 0, 2];
const SHIFT_DIRECTIONS = [1, -1, 1];

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, value));

function smoother(value) {
  const x = clamp(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function hash(value) {
  const sine = Math.sin(value * 91.3458 + 17.234) * 47453.5453;
  return sine - Math.floor(sine);
}

function channel(value) {
  return Math.round(clamp(value, 0, 255));
}

function rgb(red, green, blue) {
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

// The favicon ages sooner than the body copy does because a tab-sized mark
// needs a readable amount of change within the first clock turn. The curve
// approaches, but never reaches, total loss: the character remains recognisable
// even after the page has been left open for a long time.
export function faviconDamage(elapsedMs) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  return clamp(1 - Math.exp(-elapsed / AGE_CONSTANT_MS));
}

// Severity comes only from displayed age. A rewind may pin `phaseElapsed` to
// the starting frame, so the same three pieces visibly travel home instead of
// changing their identities while the clock compresses many seconds at once.
export function faviconFrame(
  elapsedMs,
  { recovering = false, phaseElapsed = elapsedMs } = {},
) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const quantizedElapsed = Math.round(elapsed / FRAME_MS) * FRAME_MS;
  const phaseAge = Math.max(0, Number(phaseElapsed) || 0);
  const quantizedPhase = Math.round(phaseAge / FRAME_MS) * FRAME_MS;
  const damage = faviconDamage(quantizedElapsed);
  const phase = Math.floor(quantizedPhase / 480);
  const slices = [];

  for (let index = 0; index < SLICE_ROWS.length; index += 1) {
    const activationRank = ACTIVATION_ORDER.indexOf(index);
    const threshold = 0.055 + activationRank * 0.245;
    const strength = smoother((damage - threshold) / 0.28);
    if (strength < 0.035) continue;

    const pulse = hash(phase * 1.73 + index * 7.19);
    const amplitude = 1.1 + (index % 2) * 0.25 + pulse * 0.65;
    const shift = SHIFT_DIRECTIONS[index]
      * Math.min(2, Math.max(1, Math.round(amplitude * strength)));
    const height = 1 + ((index + phase) % 3 === 0 ? 1 : 0);
    const missing = index === 2
      && strength > 0.9
      && hash(Math.floor(phase / 2) * 3.11 + index * 11.7) < damage * 0.24;

    slices.push({
      y: SLICE_ROWS[index],
      height,
      shift,
      missing,
      strength,
    });
  }

  const shardCount = Math.round(damage * 4);
  const shardPhase = Math.floor(quantizedPhase / 320);
  const shards = Array.from({ length: shardCount }, (_, index) => {
    const direction = hash(index * 4.71 + shardPhase * 0.37) < 0.5 ? -1 : 1;
    const reach = Math.min(
      3,
      1 + Math.round(damage * (1 + hash(index * 8.13 + 4.2) * 2)),
    );
    return {
      sample: hash(index * 13.37 + shardPhase * 0.91),
      dx: direction * reach,
      dy: Math.round((hash(index * 6.29 + shardPhase * 1.17) - 0.5) * damage * 8),
      size: damage > 0.82 && index === 0 ? 2 : 1,
      alpha: 0.48 + hash(index * 3.17 + 9.4) * 0.42,
    };
  });

  return {
    key: `${quantizedElapsed}:${quantizedPhase}:${recovering ? "returning" : "aging"}`,
    elapsed: quantizedElapsed,
    damage,
    recovering: Boolean(recovering),
    slices,
    shards,
  };
}

function sampleArtwork(context) {
  const pixels = context.getImageData(0, 0, SIZE, SIZE).data;
  const inkPoints = [];
  let darkRed = 0;
  let darkGreen = 0;
  let darkBlue = 0;
  let darkCount = 0;
  let lightRed = 0;
  let lightGreen = 0;
  let lightBlue = 0;
  let lightCount = 0;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha < 160) continue;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      if (luminance < 70) {
        darkRed += red;
        darkGreen += green;
        darkBlue += blue;
        darkCount += 1;
      } else if (luminance > 165) {
        lightRed += red;
        lightGreen += green;
        lightBlue += blue;
        lightCount += 1;
        inkPoints.push({ x, y });
      }
    }
  }

  return {
    background: darkCount
      ? rgb(darkRed / darkCount, darkGreen / darkCount, darkBlue / darkCount)
      : "rgb(7, 7, 7)",
    ink: lightCount
      ? rgb(lightRed / lightCount, lightGreen / lightCount, lightBlue / lightCount)
      : "rgb(245, 245, 243)",
    inkPoints,
  };
}

function clipToTile(context) {
  const inset = 0.75;
  const far = SIZE - inset;
  const radius = 5.5;
  context.beginPath();
  context.moveTo(inset + radius, inset);
  context.lineTo(far - radius, inset);
  context.quadraticCurveTo(far, inset, far, inset + radius);
  context.lineTo(far, far - radius);
  context.quadraticCurveTo(far, far, far - radius, far);
  context.lineTo(inset + radius, far);
  context.quadraticCurveTo(inset, far, inset, far - radius);
  context.lineTo(inset, inset + radius);
  context.quadraticCurveTo(inset, inset, inset + radius, inset);
  context.closePath();
  context.clip();
}

function paintFrame(canvas, clean, artwork, frame) {
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.save();
  context.imageSmoothingEnabled = false;
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, SIZE, SIZE);
  context.drawImage(clean, 0, 0);
  context.save();
  clipToTile(context);

  for (const slice of frame.slices) {
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = artwork.background;
    context.fillRect(0, slice.y, SIZE, slice.height);
    if (!slice.missing) {
      context.drawImage(
        clean,
        0,
        slice.y,
        SIZE,
        slice.height,
        slice.shift,
        slice.y,
        SIZE,
        slice.height,
      );
    }

    // On the way home, a dim afterimage occupies the space between a displaced
    // stroke and its remembered position. At favicon scale it reads as the
    // character actively knitting itself back together.
    if (frame.recovering) {
      context.globalAlpha = 0.2 + slice.strength * 0.18;
      context.globalCompositeOperation = "screen";
      context.drawImage(
        clean,
        0,
        slice.y,
        SIZE,
        slice.height,
        Math.round(slice.shift / 2),
        slice.y,
        SIZE,
        slice.height,
      );
    }
  }

  context.globalCompositeOperation = "source-over";
  context.fillStyle = artwork.ink;
  for (const shard of frame.shards) {
    if (!artwork.inkPoints.length) break;
    const point = artwork.inkPoints[
      Math.min(
        artwork.inkPoints.length - 1,
        Math.floor(shard.sample * artwork.inkPoints.length),
      )
    ];
    context.globalAlpha = shard.alpha * (frame.recovering ? 0.72 : 1);
    context.fillRect(
      point.x + shard.dx,
      point.y + shard.dy,
      shard.size,
      shard.size,
    );
  }

  // Slice and fleck work is clipped inside the tile, leaving the original
  // antialiased rounded-square silhouette untouched.
  context.restore();
  context.restore();
  return canvas.toDataURL("image/png");
}

function inertController() {
  return {
    setElapsed() {},
    destroy() {},
  };
}

export function createAgingFavicon({
  documentRef = globalThis.document,
  sourceUrl = "/favicon-32.png",
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const link = documentRef?.querySelector?.("#site-favicon");
  if (!link || !documentRef?.createElement) return inertController();

  const originalHref = link.getAttribute("href") || sourceUrl;
  const clean = documentRef.createElement("canvas");
  const canvas = documentRef.createElement("canvas");
  const image = documentRef.createElement("img");
  if (!clean?.getContext || !canvas?.getContext || !image) return inertController();

  clean.width = SIZE;
  clean.height = SIZE;
  canvas.width = SIZE;
  canvas.height = SIZE;
  let artwork = null;
  let ready = false;
  let destroyed = false;
  let latestElapsed = 0;
  let latestRecovering = false;
  let throttleRecovery = false;
  let recoveryPhaseElapsed = 0;
  let lastPaintAt = Number.NEGATIVE_INFINITY;
  let lastFrameKey = "clean";
  const view = documentRef.defaultView || globalThis;
  const reducedMotion = view.matchMedia?.("(prefers-reduced-motion: reduce)");

  function restoreStatic() {
    if (link.getAttribute("href") !== originalHref) link.setAttribute("href", originalHref);
    lastFrameKey = "clean";
  }

  function renderLatest({ force = false } = {}) {
    if (!ready || destroyed) return;
    if (reducedMotion?.matches) {
      restoreStatic();
      return;
    }
    // Background tabs keep their last visible state but do no raster work.
    // The latest age is painted once when the document becomes visible again.
    if (documentRef.hidden) return;
    const frame = faviconFrame(latestElapsed, {
      recovering: latestRecovering,
      phaseElapsed: latestRecovering ? recoveryPhaseElapsed : latestElapsed,
    });
    if (frame.damage < 0.012) {
      restoreStatic();
      return;
    }
    if (frame.key === lastFrameKey) return;
    const paintedAt = now();
    if (
      !force
      && throttleRecovery
      && paintedAt - lastPaintAt < RECOVERY_PAINT_MS
    ) return;
    try {
      const url = paintFrame(canvas, clean, artwork, frame);
      if (!url || destroyed) return;
      link.setAttribute("href", url);
      lastFrameKey = frame.key;
      lastPaintAt = paintedAt;
    } catch {
      restoreStatic();
    }
  }

  function prepare() {
    if (ready || destroyed || !image.naturalWidth) return;
    try {
      const context = clean.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, SIZE, SIZE);
      context.drawImage(image, 0, 0, SIZE, SIZE);
      artwork = sampleArtwork(context);
      ready = true;
      renderLatest();
    } catch {
      restoreStatic();
    }
  }

  image.decoding = "async";
  image.addEventListener?.("load", prepare, { once: true });
  image.src = sourceUrl;
  if (image.complete && image.naturalWidth) queueMicrotask(prepare);
  image.decode?.().then(prepare).catch(() => {});

  function onVisibilityChange() {
    if (!documentRef.hidden) renderLatest({ force: true });
  }

  function onMotionPreference() {
    if (reducedMotion?.matches) restoreStatic();
    else renderLatest({ force: true });
  }

  documentRef.addEventListener?.("visibilitychange", onVisibilityChange);
  reducedMotion?.addEventListener?.("change", onMotionPreference);

  return {
    setElapsed(elapsedMs, options = {}) {
      const next = Math.max(0, Number(elapsedMs) || 0);
      const explicitlyRecovering = typeof options.recovering === "boolean";
      const recovering = explicitlyRecovering
        ? options.recovering
        : next < latestElapsed - 1;
      if (recovering && !latestRecovering) recoveryPhaseElapsed = latestElapsed;
      if (!recovering) recoveryPhaseElapsed = next;
      latestRecovering = recovering;
      throttleRecovery = explicitlyRecovering && recovering;
      latestElapsed = next;
      renderLatest();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      restoreStatic();
      image.removeEventListener?.("load", prepare);
      documentRef.removeEventListener?.("visibilitychange", onVisibilityChange);
      reducedMotion?.removeEventListener?.("change", onMotionPreference);
    },
  };
}
