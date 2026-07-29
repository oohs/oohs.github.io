// The photographs corrupt too, and they do it the way a damaged image file
// actually does: blocks tear sideways and smear, rather than fading or being
// covered up.
//
// The mechanism is one canvas per photograph, laid exactly over the `<img>`
// and painted from the original bitmap. Corruption is repainting a block from
// the wrong place in the source. That single decision buys everything else for
// free, because `captureLayer` reads its tiles from this canvas rather than
// from the `<img>`:
//
//   * hovering explodes the *corrupted* pixels, and cleaning a block repaints
//     it from the original, so restoration is visible in the same gesture;
//   * the dragon is assembled from the canvas, so a page left to rot long
//     enough builds its attractor out of damaged photograph.
//
// Blocks share the grid the diffusion tiles use, so a restore key names one
// block exactly and no mapping is needed between the two systems.

import { RAMP_MS, onsetFrom } from "./aging.js";

// Roughly how many tiles a photograph is cut into. Also the corruption block
// count: one grid serves both so their keys line up.
export const IMAGE_TILE_TARGET = 260;

const CORRUPT_LEVELS = 6;
const MAX_PAINTS_PER_TICK = 26;
const CHURN_PER_TICK = 10;
// A restored block waits this long, at most, before it begins again.
const RESTART_SPAN_MS = 52000;

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function diffuseTileTarget(image) {
  const requested = Number(image?.dataset?.diffuseTiles);
  if (!Number.isFinite(requested)) return IMAGE_TILE_TARGET;
  return Math.max(16, Math.min(IMAGE_TILE_TARGET, Math.round(requested)));
}

export function photoGrid(width, height, target = IMAGE_TILE_TARGET) {
  const aspect = Math.max(0.05, width / Math.max(1, height));
  const boundedTarget = Math.max(16, Math.min(IMAGE_TILE_TARGET, target));
  const columns = Math.max(4, Math.round(Math.sqrt(boundedTarget * aspect)));
  const rows = Math.max(4, Math.round(boundedTarget / columns));
  return { columns, rows };
}

// Canvas tiles must meet on physical pixel boundaries. Fractional destination
// rectangles make independently repainted neighbours sample their shared edge
// differently, which eventually exposes a faint grid across a restored photo.
// Rounding the cumulative boundaries (rather than each tile's width) assigns
// every canvas pixel to exactly one block with no gaps or overlaps.
export function photoBlockRect(width, height, columns, rows, column, row) {
  const canvasWidth = Math.max(1, Math.round(Number(width) || 1));
  const canvasHeight = Math.max(1, Math.round(Number(height) || 1));
  const columnCount = Math.max(1, Math.round(Number(columns) || 1));
  const rowCount = Math.max(1, Math.round(Number(rows) || 1));
  const blockColumn = Math.max(
    0,
    Math.min(columnCount - 1, Math.floor(Number(column) || 0)),
  );
  const blockRow = Math.max(
    0,
    Math.min(rowCount - 1, Math.floor(Number(row) || 0)),
  );
  const left = Math.round(blockColumn * canvasWidth / columnCount);
  const right = Math.round((blockColumn + 1) * canvasWidth / columnCount);
  const top = Math.round(blockRow * canvasHeight / rowCount);
  const bottom = Math.round((blockRow + 1) * canvasHeight / rowCount);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function restoresDiffuseBlock(keys, surfaceKey, blockKey) {
  return keys?.has(blockKey) || keys?.has(`${surfaceKey}:whole`) || false;
}

export function releaseDiffuseSurface(surface) {
  if (!surface) return;
  const { image, canvas } = surface;
  // A stale surface must not unhide an image that has already acquired a
  // newer replacement canvas.
  if (image?.__photoSurface === surface) {
    delete image.dataset.diffuseCanvasReady;
    delete image.__photoSurface;
  }
  canvas?.remove();
}

export function createPhotos({
  layers,
  tileTarget = IMAGE_TILE_TARGET,
  dprCap = 2,
  maxPaintsPerTick = MAX_PAINTS_PER_TICK,
  churnPerTick = CHURN_PER_TICK,
  cacheCleanBlocks = false,
} = {}) {
  const surfaceTileTarget = Math.max(
    16,
    Math.min(IMAGE_TILE_TARGET, Math.round(Number(tileTarget) || IMAGE_TILE_TARGET)),
  );
  const surfaceDprCap = Math.max(1, Math.min(3, Number(dprCap) || 2));
  const paintBudget = Math.max(
    1,
    Math.floor(Number(maxPaintsPerTick) || MAX_PAINTS_PER_TICK),
  );
  const churnBudget = Math.max(
    1,
    Math.floor(Number(churnPerTick) || CHURN_PER_TICK),
  );
  const useCleanBlockCache = Boolean(cacheCleanBlocks);
  let surfaces = [];
  let paintItems = [];
  let elapsed = 0;
  let paintCursor = 0;
  let churnCursor = 0;

  function seedBlock(block, index) {
    block.band = 0.06 + hash01(index * 3.1) * 0.62;
    block.band2 = 0.1 + hash01(index * 7.7) * 0.7;
    block.dir = hash01(index * 11.9) < 0.5 ? -1 : 1;
    block.smear = hash01(index * 17.3);
  }

  function paintCleanSurface(surface) {
    const {
      context,
      image,
      canvas,
      cleanCanvas,
    } = surface;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (cleanCanvas) {
      context.drawImage(cleanCanvas, 0, 0);
      return;
    }
    context.drawImage(
      image,
      0,
      0,
      image.naturalWidth,
      image.naturalHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }

  // Mobile block repair used to rescale the complete source photograph once
  // for every individual tile. Keep one clean, canvas-sized bitmap instead:
  // copying an integer pixel rectangle from it is both cheaper and guaranteed
  // to meet its neighbours exactly. Desktop leaves this disabled and retains
  // its established source-image draw path.
  function prepareCleanBlockCache(image, canvas, previous) {
    if (!useCleanBlockCache) return null;
    const cleanCanvas = previous?.cleanCanvas || document.createElement("canvas");
    cleanCanvas.width = canvas.width;
    cleanCanvas.height = canvas.height;
    const cleanContext = cleanCanvas.getContext("2d");
    if (!cleanContext) return null;
    cleanContext.clearRect(0, 0, cleanCanvas.width, cleanCanvas.height);
    cleanContext.drawImage(
      image,
      0,
      0,
      image.naturalWidth,
      image.naturalHeight,
      0,
      0,
      cleanCanvas.width,
      cleanCanvas.height,
    );
    return cleanCanvas;
  }

  // Repaint one block: the clean bitmap first, then — if it is damaged — a
  // horizontal band fetched from the wrong x, and at heavy damage a single
  // source column stretched across the block. Tearing and smearing are what
  // broken image data looks like; a blur or a fade is what a filter looks like.
  function paint(surface, block) {
    const {
      context,
      image,
      canvas,
      cleanCanvas,
      columns,
      rows,
    } = surface;
    const {
      left: x,
      top: y,
      width: blockWidth,
      height: blockHeight,
    } = photoBlockRect(
      canvas.width,
      canvas.height,
      columns,
      rows,
      block.column,
      block.row,
    );
    if (!blockWidth || !blockHeight) return;
    const sourceWidth = image.naturalWidth / columns;
    const sourceHeight = image.naturalHeight / rows;
    const sourceX = block.column * sourceWidth;
    const sourceY = block.row * sourceHeight;

    // Clear exactly one physical-pixel cell, then clip every draw to it. The
    // clean pixels are painted with the same whole-image transform used by
    // paintCleanSurface; independently restored neighbours therefore meet
    // perfectly instead of each resampling its own fractional source tile.
    // Clearing first also removes stale tears beneath transparent logo pixels.
    context.clearRect(x, y, blockWidth, blockHeight);
    context.save();
    context.beginPath();
    context.rect(x, y, blockWidth, blockHeight);
    context.clip();
    if (cleanCanvas) {
      context.drawImage(
        cleanCanvas,
        x,
        y,
        blockWidth,
        blockHeight,
        x,
        y,
        blockWidth,
        blockHeight,
      );
    } else {
      context.drawImage(
        image,
        0,
        0,
        image.naturalWidth,
        image.naturalHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    }
    if (block.level <= 0) {
      context.restore();
      return;
    }

    const damage = block.level / CORRUPT_LEVELS;
    const bandHeight = sourceHeight * (0.16 + 0.34 * damage);
    const bandTop = sourceY + sourceHeight * block.band;
    const shifted = Math.max(0, Math.min(
      image.naturalWidth - sourceWidth,
      sourceX + block.dir * sourceWidth * (0.6 + 5.2 * damage),
    ));
    context.drawImage(
      image,
      shifted, bandTop, sourceWidth, bandHeight,
      x, y + blockHeight * block.band, blockWidth, blockHeight * (0.16 + 0.34 * damage),
    );

    if (damage > 0.55) {
      // One column of source stretched the width of the block: the classic
      // look of a decoder that lost the rest of the row.
      const column = Math.max(0, Math.min(
        image.naturalWidth - 1,
        sourceX + sourceWidth * block.smear,
      ));
      context.drawImage(
        image,
        column, sourceY + sourceHeight * block.band2, 1, sourceHeight * 0.16,
        x, y + blockHeight * block.band2, blockWidth, blockHeight * 0.14 * damage,
      );
    }
    context.restore();
  }

  function levelFor(block) {
    if (elapsed <= block.onset) return 0;
    return Math.round(Math.min(1, (elapsed - block.onset) / block.ramp) * CORRUPT_LEVELS);
  }

  // Rebuilt whenever the type is refitted or the window resizes: the canvas is
  // sized to the laid-out box, so a stale one would paint at the wrong scale.
  // Block state is carried across by key, so a resize does not heal the page.
  function rebuild() {
    const next = [];
    const stale = new Set(surfaces);
    for (const [index, layer] of layers.entries()) {
      for (const [imageOrder, image] of [...layer.querySelectorAll("img[data-diffuse]")].entries()) {
        const previous = image.__photoSurface;
        if (previous) stale.delete(previous);
        if (!image.complete || !image.naturalWidth) {
          releaseDiffuseSurface(previous);
          continue;
        }
        const box = image.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) {
          releaseDiffuseSurface(previous);
          continue;
        }
        const key = image.dataset.imageKey || `${index ? "b" : "a"}:img`;
        const { columns, rows } = photoGrid(
          box.width,
          box.height,
          Math.min(surfaceTileTarget, diffuseTileTarget(image)),
        );
        const dpr = Math.max(1, Math.min(surfaceDprCap, devicePixelRatio || 1));

        let canvas = previous?.canvas;
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.className = "photo-canvas";
          canvas.setAttribute("aria-hidden", "true");
          image.parentElement?.appendChild(canvas);
        } else if (!canvas.isConnected) {
          image.parentElement?.appendChild(canvas);
        }

        // Resizing clears a canvas. Reveal the source first so an unsupported
        // context or failed repaint degrades to the normal image, never to a
        // ready-marked blank rectangle.
        delete image.dataset.diffuseCanvasReady;
        try {
          canvas.width = Math.max(1, Math.round(box.width * dpr));
          canvas.height = Math.max(1, Math.round(box.height * dpr));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("2D canvas unavailable");

          const blocks = [];
          const carried = previous && previous.columns === columns && previous.rows === rows
            ? previous.blocks
            : null;
          for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
              const ordinal = row * columns + column;
              const old = carried?.[ordinal];
              const block = old || {
                key: `${key}:${column}:${row}`,
                column,
                row,
                level: 0,
                onset: onsetFrom(hash01(ordinal * 5.7 + index * 91.3 + imageOrder * 43.7)),
                ramp: RAMP_MS * (0.75 + hash01(ordinal * 13.1) * 0.5),
              };
              if (!old) seedBlock(block, ordinal + index * 977 + imageOrder * 619);
              block.column = column;
              block.row = row;
              blocks.push(block);
            }
          }

          const cleanCanvas = prepareCleanBlockCache(image, canvas, previous);
          const surface = {
            image,
            canvas,
            context,
            cleanCanvas,
            columns,
            rows,
            blocks,
            dpr,
            key,
          };
          // A one-pass clean bitmap has no fractional tile-resampling seams.
          // Reapply only the blocks that are actually damaged.
          paintCleanSurface(surface);
          for (const block of blocks) {
            if (block.level > 0) paint(surface, block);
          }
          image.__photoSurface = surface;
          next.push(surface);
          // Keep the source in the layout and accessibility tree, but display
          // only the finished canvas. Transparent logo edges would otherwise
          // composite twice and leave a dark square/halo behind the fragments.
          image.dataset.diffuseCanvasReady = "true";
        } catch {
          releaseDiffuseSurface(previous || { image, canvas });
        }
      }
    }
    // Images can disappear from the queried layers between resize passes.
    // Dispose their old surfaces before losing the only cleanup reference.
    for (const surface of stale) releaseDiffuseSurface(surface);
    surfaces = next;
    paintItems = surfaces.flatMap((surface) => (
      surface.blocks.map((block) => ({ surface, block }))
    ));
  }

  return {
    rebuild,

    get surfaces() {
      return surfaces;
    },

    setElapsed(next, { immediate = false, settle = false } = {}) {
      const value = Number(next);
      if (!Number.isFinite(value)) return { painted: 0, settled: true };
      elapsed = Math.max(0, value);
      if (!paintItems.length) return { painted: 0, settled: true };

      // Twelve o'clock is a common destination when reversing the page. All
      // blocks are clean there, so repaint each photograph once instead of
      // resampling the entire source image once per block.
      if (elapsed === 0) {
        let painted = 0;
        for (const surface of surfaces) {
          let changed = false;
          for (const block of surface.blocks) {
            if (block.level > 0) {
              block.level = 0;
              painted += 1;
              changed = true;
            }
          }
          if (changed) paintCleanSurface(surface);
        }
        paintCursor = 0;
        return { painted, settled: true };
      }

      const limit = immediate
        ? Number.POSITIVE_INFINITY
        : paintBudget;
      const scanLimit = immediate || settle
        ? paintItems.length
        : Math.min(paintItems.length, Math.max(48, paintBudget * 6));
      const changes = [];
      let scanned = 0;
      for (
        let step = 0;
        step < scanLimit && changes.length < limit;
        step += 1
      ) {
        scanned = step + 1;
        const { surface, block } = paintItems[(paintCursor + step) % paintItems.length];
        const target = levelFor(block);
        if (target === block.level) continue;
        changes.push({ surface, block, target });
      }
      for (const { surface, block, target } of changes) {
        block.level = target;
        paint(surface, block);
      }
      paintCursor = (paintCursor + Math.max(scanned, 1)) % paintItems.length;
      return {
        painted: changes.length,
        settled: scanned >= paintItems.length && changes.length < limit,
      };
    },

    // Re-roll the geometry of a few damaged blocks so the tearing keeps moving
    // instead of settling into a fixed pattern.
    churn() {
      if (!paintItems.length) return;
      let changed = 0;
      for (let step = 0; step < paintItems.length && changed < churnBudget; step += 1) {
        const { surface, block } = paintItems[(churnCursor + step) % paintItems.length];
        if (block.level <= 0) continue;
        seedBlock(block, Math.random() * 10000);
        paint(surface, block);
        changed += 1;
      }
      churnCursor = (churnCursor + churnBudget * 5 + 3) % paintItems.length;
    },

    // Hovering cleans a block and pushes its onset out past now, so it holds
    // clean for a while and then has to start over — the same contract the
    // text uses.
    restore(keys) {
      if (!keys?.size || !surfaces.length) return 0;
      let healed = 0;
      for (const surface of surfaces) {
        if (keys.has(`${surface.key}:whole`)) {
          for (const block of surface.blocks) {
            block.onset = elapsed + Math.cbrt(Math.random()) * RESTART_SPAN_MS;
            if (block.level > 0) healed += 1;
            block.level = 0;
          }
          // Whole-logo explosions settle back to one clean draw, rather than
          // 25 independently resampled tiles that preserve a faint grid.
          paintCleanSurface(surface);
          continue;
        }
        for (const block of surface.blocks) {
          if (!restoresDiffuseBlock(keys, surface.key, block.key)) continue;
          block.onset = elapsed + Math.cbrt(Math.random()) * RESTART_SPAN_MS;
          if (block.level > 0) {
            block.level = 0;
            paint(surface, block);
            healed += 1;
          }
        }
      }
      return healed;
    },

    reset() {
      elapsed = 0;
      for (const [index, surface] of surfaces.entries()) {
        surface.blocks.forEach((block, ordinal) => {
          block.level = 0;
          block.onset = onsetFrom(Math.random());
          seedBlock(block, ordinal + index * 977 + Math.random() * 1000);
        });
        // Every block is clean after a reset, so rebuilding it tile by tile
        // needlessly performs hundreds of identical source-image draws during
        // the animation handoff. One full-surface repaint is pixel-equivalent.
        paintCleanSurface(surface);
      }
    },

    destroy() {
      for (const surface of surfaces) releaseDiffuseSurface(surface);
      surfaces = [];
      paintItems = [];
    },
  };
}
