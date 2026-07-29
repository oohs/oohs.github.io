// The page corrupts as it sits, and you clean it by touching it.
//
// Corruption arrives one character at a time and then accelerates. Each
// character has its own onset — the moment it starts going wrong — and those
// onsets are drawn so that the *fraction* of the page that has started is the
// cube of elapsed time. A cubic means almost nothing happens for a while and
// then it runs away: one character, then a few, then handfuls, then the page.
// Uniform onsets give a steady drizzle from the first second instead, which is
// what "it starts too strong" looks like.
//
// Onsets and rates come from a hash of each character's own key, so damage is
// scattered across the page rather than sweeping through it, and the same page
// always breaks in the same order.
//
// Hovering is restoration. The hover field already explodes a character into
// fragments on the canvas; those fragments are drawn from the *clean* glyph, so
// the explosion reads as the thing that cleans it. A restored character has its
// onset pushed back out into the future, so it stays clean and then has to
// begin again from nothing. Each one also winds the clock back.
//
// The corruption itself is deliberately cheap. A corrupted glyph is drawn with
// overlay pseudo-elements sitting at fixed offsets from custom properties —
// pure paint. Only a bounded, rotating subset is *live* at any moment, carrying
// the CSS animations that make it move; the page reads as though all of it is
// glitching while a hundred-odd elements actually animate.

// One turn of the clock hand. The hand loops, so this is a period, not a
// lifetime — the page goes on ageing for as many turns as it takes.
export const REVOLUTION_MS = 22000;

// When the last character starts corrupting, and how long one takes to go from
// clean to fully gone. Together these decide when the page is finished.
export const ONSET_SPAN_MS = 225000;
export const RAMP_MS = 62000;
const RAMP_SPREAD = 0.5;

// A restored character waits at most this long before it begins again.
const RESTART_SPAN_MS = 52000;
// Time wound off the clock per restored character.
const RESTORE_REWIND_MS = 500;

const TICK_MS = 380;
const MAX_WRITES_PER_TICK = 90;

// How often the wrong characters are redrawn, and how many change each time.
// This is the churn that stops the corruption reading as a static texture.
const NOISE_TICK_MS = 110;
const NOISE_PER_TICK = 30;

// How many corrupted glyphs animate at once, and how often that set rotates.
const LIVE_LIMIT = 96;
const LIVE_ROTATE_MS = 700;

const CORRUPT_LEVELS = 6;
// Level past which the displaced slice stops being the character itself and
// starts being a wrong one.
const GARBLE_FROM = 4;

// The wrong characters. Deliberately text-weight rather than solid blocks:
// `█` and `▓` land as censor bars over a serif paragraph, which reads as
// redaction rather than corruption. Light shades, box rules and mojibake-ish
// letterforms keep the page looking like text that has gone wrong.
const NOISE = [
  "░", "▒", "▚", "▞", "╱", "╲", "╳", "┼", "┊", "╎", "┆", "╌",
  "§", "¤", "‡", "†", "þ", "æ", "ø", "ð", "ß", "µ", "¶", "±", "¬",
  "%", "#", "@", "&", "$", "?", "*", "~", "^", "<", ">", "|", "/", "\\",
];

export function titleNoise(seed) {
  return NOISE[Math.floor(Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % NOISE.length)];
}

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function hashKey(key) {
  let accumulator = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    accumulator ^= key.charCodeAt(index);
    accumulator = Math.imul(accumulator, 16777619);
  }
  return hash01((accumulator >>> 0) % 100000);
}

function noiseFor(seed) {
  return NOISE[Math.floor(hash01(seed) * NOISE.length) % NOISE.length];
}

// Cube root of a uniform draw. The number of characters whose onset has passed
// then grows as the cube of time: one, a few, handfuls, all of it.
export function onsetFrom(uniform) {
  return Math.cbrt(uniform) * ONSET_SPAN_MS;
}

export function createAging({
  layers,
  palette,
  onState,
  performance: performanceOptions = {},
}) {
  void palette;
  const tickMs = Math.max(16, Number(performanceOptions.tickMs) || TICK_MS);
  const maxWritesPerTick = Math.max(
    1,
    Math.floor(Number(performanceOptions.maxWritesPerTick) || MAX_WRITES_PER_TICK),
  );
  const noiseTickMs = Math.max(
    16,
    Number(performanceOptions.noiseTickMs) || NOISE_TICK_MS,
  );
  const noisePerTick = Math.max(
    1,
    Math.floor(Number(performanceOptions.noisePerTick) || NOISE_PER_TICK),
  );
  const liveLimit = Math.max(
    1,
    Math.floor(Number(performanceOptions.liveLimit) || LIVE_LIMIT),
  );
  const liveRotateMs = Math.max(
    16,
    Number(performanceOptions.liveRotateMs) || LIVE_ROTATE_MS,
  );
  const faceRecords = [new Map(), new Map()];
  const faceRecordLists = [null, null];

  let face = 0;
  let running = false;
  let active = false;
  let timer = 0;
  let noiseTimer = 0;
  let liveTimer = 0;
  let lastTickAt = performance.now();

  // Time on this page, less whatever restoring has taken back off it. Never
  // capped: the hand goes round as many times as it needs to.
  let elapsed = 0;
  let writeCursor = 0;
  let noiseCursor = 0;
  let liveCursor = 0;
  let live = [];
  let reported = null;

  function clearLive() {
    for (const record of live) record.ink.removeAttribute("data-live");
    live = [];
  }

  function collect(index) {
    const store = faceRecords[index];
    if (faceRecordLists[index]) return store;
    for (const token of layers[index].querySelectorAll(".glyph-token")) {
      const ink = token.querySelector(":scope > .glyph-ink");
      const key = token.dataset.glyphKey;
      if (!ink || !key) continue;
      const seed = hashKey(key);
      store.set(key, {
        key,
        ink,
        seed,
        onset: onsetFrom(seed),
        ramp: RAMP_MS * (1 - RAMP_SPREAD / 2 + hash01(seed * 3.7) * RAMP_SPREAD),
        level: 0,
        pinned: false,
        noiseSeed: seed * 31.7,
      });
    }
    faceRecordLists[index] = [...store.values()];
    return store;
  }

  function recordsFor(index) {
    collect(index);
    return faceRecordLists[index];
  }

  function levelFor(record) {
    if (elapsed <= record.onset) return 0;
    const progress = Math.min(1, (elapsed - record.onset) / record.ramp);
    return Math.round(progress * CORRUPT_LEVELS);
  }

  // The advance width is pinned to the clean character before any overlay is
  // attached, so a page can corrupt completely without a line reflowing.
  function pin(record) {
    if (record.pinned) return true;
    const width = record.measuredWidth ?? record.ink.getBoundingClientRect().width;
    delete record.measuredWidth;
    if (!width) return false;
    record.ink.style.width = `${width.toFixed(2)}px`;
    record.pinned = true;
    return true;
  }

  function applyLevel(record, level) {
    if (level === record.level) return;
    const previous = record.level;
    record.level = level;
    const { ink, seed } = record;
    if (level <= 0) {
      ink.removeAttribute("data-corrupt");
      ink.removeAttribute("data-glyph");
      ink.removeAttribute("data-live");
      ink.style.width = "";
      ink.style.removeProperty("--c");
      record.pinned = false;
      return;
    }
    if (!pin(record)) {
      record.level = previous;
      return;
    }
    ink.style.setProperty("--c", (level / CORRUPT_LEVELS).toFixed(3));
    if (!previous) {
      // Fixed per-glyph geometry for the still layers, and desynchronised
      // timings for when this glyph is picked up as one of the live ones.
      ink.style.setProperty("--gx", `${(hash01(seed * 7.1) * 2 - 1).toFixed(2)}`);
      ink.style.setProperty("--gy", `${(hash01(seed * 11.3) * 2 - 1).toFixed(2)}`);
      ink.style.setProperty("--gband", `${(26 + hash01(seed * 13.9) * 32).toFixed(1)}%`);
      ink.style.setProperty("--gd", `${(620 + hash01(seed * 17.7) * 900).toFixed(0)}ms`);
      ink.style.setProperty("--gdelay", `-${(hash01(seed * 19.3) * 1500).toFixed(0)}ms`);
      ink.dataset.corrupt = "";
    }
    writeSlice(record);
  }

  // What the displaced slice shows: the character itself while the damage is
  // light, a wrong one once it is heavy.
  function writeSlice(record) {
    record.ink.dataset.glyph = record.level >= GARBLE_FROM
      ? noiseFor(record.noiseSeed)
      : record.ink.textContent;
  }

  // A restored character does not merely drop to zero — its onset is pushed
  // back out past now, so it stays clean for a while and then starts again
  // from nothing. Without that it is re-corrupted on the very next tick.
  function restoreRecord(record, reschedule = true) {
    if (!record) return false;
    const wasCorrupt = record.level > 0;
    if (reschedule) {
      record.onset = elapsed + Math.cbrt(Math.random()) * RESTART_SPAN_MS;
    }
    if (wasCorrupt) applyLevel(record, 0);
    return wasCorrupt;
  }

  function publish(metadata = {}) {
    const records = faceRecords[face];
    let broken = 0;
    for (const record of records.values()) {
      if (record.level > 0) broken += 1;
    }
    reported = {
      elapsed,
      seconds: elapsed / 1000,
      turns: elapsed / REVOLUTION_MS,
      corrupted: records.size ? broken / records.size : 0,
    };
    onState?.(reported, metadata);
  }

  // Bring the visible face toward the level implied by `elapsed`. Live
  // dragging scans only a bounded slice; release settlement may scan the full
  // face but still caps writes per frame. Width reads are batched before style
  // writes so a large clockwise turn cannot alternate layout reads and writes
  // thousands of times in one frame.
  function reconcileLevels(
    writeLimit = maxWritesPerTick,
    scanLimit = Math.max(64, maxWritesPerTick * 6),
  ) {
    const records = recordsFor(face);
    if (!records.length) return { writes: 0, settled: true };
    const maximumWrites = Number.isFinite(writeLimit)
      ? Math.max(1, Math.floor(writeLimit))
      : Number.POSITIVE_INFINITY;
    const maximumScans = Number.isFinite(scanLimit)
      ? Math.min(records.length, Math.max(1, Math.floor(scanLimit)))
      : records.length;
    const changes = [];
    let scanned = 0;
    for (
      let step = 0;
      step < maximumScans && changes.length < maximumWrites;
      step += 1
    ) {
      scanned = step + 1;
      const record = records[(writeCursor + step) % records.length];
      const target = levelFor(record);
      if (target === record.level) continue;
      changes.push({ record, target });
    }
    for (const { record, target } of changes) {
      if (target > 0 && !record.pinned) {
        record.measuredWidth = record.ink.getBoundingClientRect().width;
      }
    }
    for (const { record, target } of changes) {
      applyLevel(record, target);
    }
    writeCursor = (writeCursor + Math.max(scanned, 1)) % records.length;
    return {
      writes: changes.length,
      // Hitting the write ceiling exactly is treated as unfinished. One cheap
      // verification pass is preferable to capturing one stale final glyph.
      settled: scanned >= records.length && changes.length < maximumWrites,
    };
  }

  // Redraw the wrong characters on a subset. This is the churn: without it the
  // corruption is a texture rather than something happening.
  function churn() {
    noiseTimer = 0;
    if (!running) return;
    if (active) {
      const records = [...collect(face).values()];
      if (records.length) {
        let changed = 0;
        for (let step = 0; step < records.length && changed < noisePerTick; step += 1) {
          const record = records[(noiseCursor + step) % records.length];
          if (record.level < GARBLE_FROM) continue;
          record.noiseSeed += 1.618;
          writeSlice(record);
          changed += 1;
        }
        noiseCursor = (noiseCursor + noisePerTick * 3) % Math.max(1, records.length);
      }
    }
    noiseTimer = setTimeout(churn, noiseTickMs);
  }

  // Rotate which corrupted glyphs are animating. Everything corrupted looks
  // broken; only these few are moving at any instant.
  function rotateLive() {
    liveTimer = 0;
    if (!running) return;
    if (active) {
      clearLive();
      const records = [...collect(face).values()];
      if (records.length) {
        for (let step = 0; step < records.length && live.length < liveLimit; step += 1) {
          const record = records[(liveCursor + step) % records.length];
          if (record.level <= 0) continue;
          record.ink.dataset.live = "";
          live.push(record);
        }
        liveCursor = (liveCursor + liveLimit * 2 + 7) % records.length;
      }
    }
    liveTimer = setTimeout(rotateLive, liveRotateMs);
  }

  function tick() {
    timer = 0;
    if (!running) return;
    const now = performance.now();
    // The clock only runs while the DOM page is the thing on screen. The
    // attractor is not a page and does not have an age: time spent watching
    // the dragon costs nothing, and the hand sits at zero until the document
    // comes back.
    if (active) elapsed += Math.min(4000, now - lastTickAt);
    lastTickAt = now;

    if (active) {
      // Style writes are budgeted, and the scan starts from a rotating cursor.
      // Scanning from the top instead starves the end of the document whenever
      // the budget saturates.
      reconcileLevels();
    }

    // While the canvas owns the screen, elapsed time and DOM corruption are
    // both frozen. Publishing that identical state would still make every
    // downstream photo surface scan its blocks during the expensive global
    // transition, so only notify consumers when the page is active.
    if (active) publish();
    schedule();
  }

  function schedule() {
    if (!running || timer) return;
    timer = setTimeout(tick, tickMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastTickAt = performance.now();
      publish();
      schedule();
      if (!noiseTimer) noiseTimer = setTimeout(churn, noiseTickMs);
      if (!liveTimer) liveTimer = setTimeout(rotateLive, liveRotateMs);
    },

    stop() {
      running = false;
      for (const handle of [timer, noiseTimer, liveTimer]) clearTimeout(handle);
      timer = 0;
      noiseTimer = 0;
      liveTimer = 0;
      clearLive();
    },

    // Whether the DOM page is the thing on screen. False while the canvas owns
    // the display, which both pauses the style writes and stops the clock.
    setActive(next) {
      if (Boolean(next) === active) return;
      active = Boolean(next);
      if (!active) clearLive();
      lastTickAt = performance.now();
    },

    setFace(next) {
      clearLive();
      face = next;
      writeCursor = 0;
      noiseCursor = 0;
      liveCursor = 0;
    },

    // Called after the type has been refitted. Pinned widths were measured
    // against the old font size and are now meaningless — left alone they
    // would crush every corrupted character into a stale box and pile the
    // letters on top of each other.
    remeasure() {
      for (const store of faceRecords) {
        for (const record of store.values()) {
          if (!record.pinned) continue;
          record.ink.style.width = "";
          record.pinned = false;
        }
      }
      for (const store of faceRecords) {
        for (const record of store.values()) {
          if (record.level > 0) pin(record);
        }
      }
    },

    restore(keys) {
      if (!running || !keys?.size) return 0;
      const store = collect(face);
      let healed = 0;
      for (const key of keys) {
        if (restoreRecord(store.get(key))) healed += 1;
      }
      if (healed) {
        elapsed = Math.max(0, elapsed - healed * RESTORE_REWIND_MS);
        publish();
      }
      return healed;
    },

    // The interactive dial changes the authoritative age, not just the hand.
    // Onsets are left untouched, so counter-clockwise movement truly retraces
    // the same corruption history instead of rerolling the page.
    setElapsed(next, { immediate = false } = {}) {
      const value = Number(next);
      if (!Number.isFinite(value)) return reported;
      elapsed = Math.max(0, value);
      lastTickAt = performance.now();
      const result = reconcileLevels(
        immediate ? Number.POSITIVE_INFINITY : maxWritesPerTick,
        immediate ? Number.POSITIVE_INFINITY : undefined,
      );
      publish({
        immediate: Boolean(immediate),
        settled: result.settled,
      });
      return reported;
    },

    // Finish a clock seek over several animation frames. The ordinary budget
    // remains the hard per-frame ceiling; convergence may take a few frames,
    // but it never turns pointer release into a burst of DOM writes.
    reconcile() {
      const result = reconcileLevels(maxWritesPerTick, Number.POSITIVE_INFINITY);
      publish({ settle: true, settled: result.settled });
      return result.settled;
    },

    // Passing into the attractor. Everything comes back and every onset is
    // drawn again, so the next life breaks in a different order.
    reset() {
      elapsed = 0;
      for (const store of faceRecords) {
        for (const record of store.values()) {
          restoreRecord(record, false);
          record.onset = onsetFrom(Math.random());
        }
      }
      clearLive();
      publish();
    },

    get state() {
      return reported;
    },

    destroy() {
      this.stop();
      faceRecords[0].clear();
      faceRecords[1].clear();
      faceRecordLists[0] = null;
      faceRecordLists[1] = null;
    },
  };
}
