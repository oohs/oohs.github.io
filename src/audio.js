// Sound stays opt-in, but once enabled it should feel like paper moving under
// the pointer rather than a stream of interface beeps. The AudioContext is only
// created by setEnabled(true) or unlock(), both of which are intended to run
// synchronously from a click, pointerdown, or keydown. That distinction matters:
// creating it later from requestAnimationFrame leaves a remembered "on" state
// looking active while browser autoplay policy keeps the context suspended.

const STORAGE_KEY = "loong:sound";

const MASTER_GAIN = 0.42;
const TICK_GAIN = 0.052;
const TICK_MIN_INTERVAL_MS = 42;
const TICK_CROWD_FALLOFF = 0.24;
const BRUSH_GAIN = 0.068;
const BRUSH_MIN_INTERVAL_MS = 58;
const RUSTLE_GAIN = 0.066;
const RUSTLE_MIN_INTERVAL_MS = 86;
const ARRIVAL_GAIN = 0.16;
const RESTORE_GAIN = 0.1;
const FEEDBACK_GAIN = 0.105;

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));

const wallTime = () => globalThis.performance?.now?.() ?? Date.now();

function makeNoiseBuffer(context) {
  const frames = Math.floor(context.sampleRate * 0.24);
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const channel = buffer.getChannelData(0);
  let paper = 0;
  for (let index = 0; index < frames; index += 1) {
    const white = Math.random() * 2 - 1;
    // A little correlated noise softens the digital hiss into a paper-like
    // texture. Filtering each individual burst shapes it further.
    paper = paper * 0.72 + white * 0.28;
    channel[index] = white * 0.42 + paper * 0.58;
  }
  return buffer;
}

export function createAudio() {
  let enabled = false;
  try {
    enabled = localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    enabled = false;
  }

  let context = null;
  let master = null;
  let noiseBuffer = null;
  let primerBuffer = null;
  let unlockPromise = null;
  let pendingFeedback = false;
  let unlockAttempt = 0;
  let lastError = "";
  let lastTickAt = 0;
  let lastBrushAt = 0;
  let lastRustleAt = 0;
  let ticksInWindow = 0;
  let tickWindowStartedAt = 0;

  function Constructor() {
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      // A page that cannot persist the preference should still make sound.
    }
  }

  function rememberError(error) {
    lastError = error instanceof Error ? error.message : String(error || "Audio unavailable");
  }

  function ensureContext() {
    if (context && context.state !== "closed") return context;
    context = null;
    master = null;
    noiseBuffer = null;
    primerBuffer = null;
    const AudioContext = Constructor();
    if (!AudioContext) {
      lastError = "Web Audio is not supported by this browser.";
      return null;
    }
    try {
      context = new AudioContext();
      master = context.createGain();
      master.gain.value = enabled ? MASTER_GAIN : 0.0001;
      master.connect(context.destination);
      noiseBuffer = makeNoiseBuffer(context);
      primerBuffer = context.createBuffer(1, 1, context.sampleRate);
      lastError = "";
      return context;
    } catch (error) {
      rememberError(error);
      context = null;
      master = null;
      noiseBuffer = null;
      primerBuffer = null;
      return null;
    }
  }

  function setMasterGain(value) {
    if (!context || !master || context.state === "closed") return;
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(Math.max(0.0001, value), now, 0.018);
  }

  function state() {
    if (!Constructor()) return "unsupported";
    if (!enabled) return "off";
    if (!context) return "locked";
    return context.state;
  }

  // Never create or resume a context here: tick/brush/rustle are commonly
  // called many times from one animation frame, which is too late to satisfy
  // autoplay policy and could otherwise queue a resume() storm. Only a trusted
  // gesture routed through unlock() may change the context state.
  function live() {
    if (!enabled || !context || context.state === "closed") return null;
    return context.state === "running" ? context : null;
  }

  function noiseBurst({
    duration,
    gain,
    frequency,
    q = 0.8,
    playbackRate = 1,
    audio = live(),
  }) {
    if (!audio || !noiseBuffer || !master) return false;
    const source = audio.createBufferSource();
    const filter = audio.createBiquadFilter();
    const envelope = audio.createGain();
    const now = audio.currentTime;
    const attack = Math.min(0.012, duration * 0.22);

    source.buffer = noiseBuffer;
    source.playbackRate.value = playbackRate;
    filter.type = "bandpass";
    filter.frequency.value = frequency;
    filter.Q.value = q;
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);
    source.start(now, Math.random() * 0.025);
    source.stop(now + duration + 0.02);
    return true;
  }

  function tone(frequency, duration, gain, type = "sine", detune = 0) {
    const audio = live();
    if (!audio || !master) return false;
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    oscillator.detune.value = detune;
    const now = audio.currentTime;
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(gain, now + duration * 0.22);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.05);
    return true;
  }

  function feedback(audio = live()) {
    return noiseBurst({
      duration: 0.13,
      gain: FEEDBACK_GAIN,
      frequency: 1080,
      q: 0.48,
      playbackRate: 0.9,
      audio,
    });
  }

  function prime(audio) {
    if (!audio || !primerBuffer || !master) return false;
    const source = audio.createBufferSource();
    const now = audio.currentTime;
    source.buffer = primerBuffer;
    source.connect(master);
    source.start(now);
    source.stop(now + 0.005);
    return true;
  }

  async function unlock({ feedback: playFeedback = false } = {}) {
    if (!enabled) return false;
    const audio = ensureContext();
    if (!audio) return false;
    pendingFeedback ||= playFeedback;
    setMasterGain(MASTER_GAIN);
    if (audio.state === "running") {
      if (pendingFeedback) feedback(audio);
      pendingFeedback = false;
      return true;
    }
    if (unlockPromise) return unlockPromise;

    // Start a one-frame silent source before resume(). This is the Web Audio
    // equivalent of priming a pump: it gives stricter browsers a source to
    // release during the trusted gesture, without leaving an audible preview
    // queued if resume fails or the user switches sound off.
    prime(audio);
    const attempt = ++unlockAttempt;
    let resumeResult;
    try {
      resumeResult = audio.resume();
    } catch (error) {
      rememberError(error);
      return false;
    }
    const activeUnlock = Promise.resolve(resumeResult)
      .then(() => {
        if (attempt !== unlockAttempt) return false;
        const ready = enabled && audio.state === "running";
        if (ready) {
          lastError = "";
          setMasterGain(MASTER_GAIN);
          if (pendingFeedback) feedback(audio);
          pendingFeedback = false;
        } else if (!enabled) {
          setMasterGain(0.0001);
        }
        return ready;
      })
      .catch((error) => {
        if (attempt === unlockAttempt) rememberError(error);
        return false;
      })
      .finally(() => {
        if (unlockPromise === activeUnlock) unlockPromise = null;
      });
    unlockPromise = activeUnlock;
    return unlockPromise;
  }

  return {
    get enabled() {
      return enabled;
    },

    get ready() {
      return enabled && context?.state === "running";
    },

    get status() {
      return {
        enabled,
        ready: enabled && context?.state === "running",
        activating: Boolean(unlockPromise),
        state: state(),
        error: lastError,
      };
    },

    // Keep this synchronous for the button integration. The click handler calls
    // unlock() immediately afterward, so context creation, source scheduling,
    // and resume all remain inside the same trusted gesture.
    setEnabled(next) {
      enabled = Boolean(next);
      persist();
      if (!enabled) {
        pendingFeedback = false;
        unlockAttempt += 1;
        unlockPromise = null;
        setMasterGain(0.0001);
        return false;
      }
      const audio = ensureContext();
      if (!audio) {
        enabled = false;
        persist();
        return false;
      }
      setMasterGain(MASTER_GAIN);
      return true;
    },

    unlock,

    // A small tactile grain retained for character admissions. The broader
    // brush API below is deliberately independent of charge/memory gating.
    tick(now = wallTime()) {
      if (!live() || !noiseBuffer) return false;
      if (now - lastTickAt < TICK_MIN_INTERVAL_MS) return false;
      if (now - tickWindowStartedAt > 500) {
        tickWindowStartedAt = now;
        ticksInWindow = 0;
      }
      ticksInWindow += 1;
      lastTickAt = now;
      const crowd = 1 / (1 + ticksInWindow * TICK_CROWD_FALLOFF);
      return noiseBurst({
        duration: 0.048,
        gain: TICK_GAIN * crowd,
        frequency: 1550 + Math.random() * 950,
        q: 0.82,
        playbackRate: 1.18 + Math.random() * 0.42,
      });
    },

    // Call once while a pointer sample is crossing text. Intensity is expected
    // in [0, 1]; internal throttling keeps dense coalesced events inexpensive.
    brush(now = wallTime(), intensity = 0.5) {
      if (!live() || !noiseBuffer) return false;
      if (now - lastBrushAt < BRUSH_MIN_INTERVAL_MS) return false;
      lastBrushAt = now;
      const strength = clamp(intensity);
      return noiseBurst({
        duration: 0.072 + strength * 0.035,
        gain: BRUSH_GAIN * (0.58 + strength * 0.42),
        frequency: 900 + strength * 520 + Math.random() * 320,
        q: 0.62,
        playbackRate: 0.88 + strength * 0.34,
      });
    },

    // Wheel input does not scroll this one-screen page, so its delta can still
    // become a soft page rustle. Amount is normalized and clamped internally.
    rustle(now = wallTime(), amount = 0.5) {
      if (!live() || !noiseBuffer) return false;
      if (now - lastRustleAt < RUSTLE_MIN_INTERVAL_MS) return false;
      lastRustleAt = now;
      const strength = clamp(amount);
      return noiseBurst({
        duration: 0.105 + strength * 0.045,
        gain: RUSTLE_GAIN * (0.5 + strength * 0.5),
        frequency: 620 + strength * 430 + Math.random() * 180,
        q: 0.55,
        playbackRate: 0.72 + strength * 0.26,
      });
    },

    // The fragments reaching the attractor. Low, wide, and gone in two seconds.
    arrival() {
      tone(72, 2.1, ARRIVAL_GAIN, "sine");
      tone(108, 1.7, ARRIVAL_GAIN * 0.55, "sine", -6);
      tone(216, 1.2, ARRIVAL_GAIN * 0.18, "triangle", 4);
    },

    // The reset. A fifth resolving upward, quiet enough to be a texture.
    restore() {
      tone(147, 1.5, RESTORE_GAIN, "sine");
      tone(220, 1.9, RESTORE_GAIN * 0.6, "sine", 3);
    },

    destroy() {
      if (context) void context.close().catch(() => {});
      context = null;
      master = null;
      noiseBuffer = null;
      primerBuffer = null;
      unlockAttempt += 1;
      unlockPromise = null;
      pendingFeedback = false;
    },
  };
}
