import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIES, getFaces } from "../src/data.js";
import {
  GLOBAL_TRANSITION_TOKEN_LIMIT,
  captureReferenceParticleCount,
  elapsedAfterClockDelta,
  handoffFragmentMix,
  imageCaptureGrid,
  imageGridBoundaries,
  imageMaskGeometry,
  limitPointerSamples,
  limitTransitionFragments,
  midpointVariantsFor,
  particleScaledThreshold,
  reserveEffectSlot,
  wholeImageFragmentMix,
  wrappedClockAngleDelta,
} from "../src/motion.js";
import {
  createAgingFavicon,
  faviconDamage,
  faviconFrame,
} from "../src/favicon.js";
import { PAPER } from "../src/palette.js";
import {
  IMAGE_TILE_TARGET,
  createPhotos,
  diffuseTileTarget,
  photoBlockRect,
  photoGrid,
  releaseDiffuseSurface,
  restoresDiffuseBlock,
} from "../src/photo.js";
import { createAudio } from "../src/audio.js";
import {
  BIRTH_MS,
  TROPICAL_YEAR_MS,
  formatLiveAge,
} from "../src/live-age.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const motion = await readFile(resolve(root, "src", "motion.js"), "utf8");
const main = await readFile(resolve(root, "src", "main.js"), "utf8");
const styles = await readFile(resolve(root, "src", "styles.css"), "utf8");
const aging = await readFile(resolve(root, "src", "aging.js"), "utf8");
const audio = await readFile(resolve(root, "src", "audio.js"), "utf8");
const data = await readFile(resolve(root, "src", "data.js"), "utf8");
const favicon = await readFile(resolve(root, "src", "favicon.js"), "utf8");
const photo = await readFile(resolve(root, "src", "photo.js"), "utf8");
const quality = await readFile(resolve(root, "src", "quality.js"), "utf8");
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");
const readme = await readFile(resolve(root, "README.md"), "utf8");
const { default: worker } = await import("../dist/server/index.js");

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `Missing source section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `Missing end marker for source section: ${end}`);
  return source.slice(from, to);
}

const expectedSlugs = [
  "dragon-eye-basin",
];
const expectedModes = [
  "sigil-eye",
];
const expectedMidpoints = [
  "dual-loong",
];
const fragmentModes = ["sigil-eye"];

assert.equal(
  readme,
  "vibe-coded. ask claude/codex what's going on, too lazy to write anything here\n",
);

// Loong Basin is the one public design and has two explicit loong low-energy states.
assert.equal(STUDIES.length, 1);
assert.deepEqual(STUDIES.map(({ number }) => number), ["01"]);
assert.deepEqual(STUDIES.map(({ slug }) => slug), expectedSlugs);
assert.deepEqual(STUDIES.map(({ mode }) => mode), expectedModes);
assert.deepEqual(STUDIES.map(({ midpoint }) => midpoint), expectedMidpoints);
assert.equal(new Set(STUDIES.map(({ slug }) => slug)).size, 1);
assert.equal(new Set(STUDIES.map(({ mode }) => mode)).size, 1);
assert.equal(new Set(STUDIES.map(({ midpoint }) => midpoint)).size, 1);
// Desktop keeps the established combined attractor: a heavy cursive 龍 in
// front of a loong that fills the frame behind it. Mobile spends every one of
// its smaller particle budget on the dragon silhouette.
assert.deepEqual(STUDIES[0].midpointVariants.map(({ id }) => id), ["seal-loong"]);
assert.deepEqual(midpointVariantsFor(STUDIES[0], "full"), STUDIES[0].midpointVariants);
assert.deepEqual(midpointVariantsFor(STUDIES[0], "lite"), STUDIES[0].midpointVariants);
assert.deepEqual(
  midpointVariantsFor(STUDIES[0], "mobile"),
  [{ id: "oriental-dragon", label: "the dragon" }],
);
assert.match(motion, /"seal-loong": \{/);
assert.match(motion, /"seal-loong": \{[\s\S]{0,120}ratio:\s*0\.46/);
assert.match(motion, /"oriental-dragon": \{\s*ratio:\s*0/);
assert.match(motion, /const calligraphyCount = Math\.round\(count \* configuration\.ratio\)/);
assert.match(motion, /const dragonCount = Math\.max\(0, count - calligraphyCount\)/);
// The background is washed back, and only while the form is actually held —
// on the way in and out these are page fragments and must not be dimmed. A
// pure-dragon mobile scene bypasses that wash entirely.
assert.match(motion, /const MIDPOINT_WASH = /);
assert.match(motion, /const formStrength = passiveMidpointEnvelope\(poseProgress\)/);
assert.match(
  motion,
  /!scene\.hasCalligraphy \|\| token\.midpointRole === "calligraphy"\s*\?\s*1\s*:\s*1 - MIDPOINT_WASH/,
);
assert.match(motion, /hasCalligraphy: tokens\.some\(\(token\) => token\.midpointRole === "calligraphy"\)/);
// Type builds the character; photographs build the wash behind it.
assert.match(motion, /const slotIsPhotograph = /);
assert.match(motion, /imageTile: glyph\.kind === "image"/);
assert.match(motion, /anchorsByRole/);
// The two forms behave differently at rest, keyed off the role rather than a
// scene-wide variant.
assert.match(motion, /if \(token\.midpointRole !== "calligraphy"\) \{/);
assert.equal(STUDIES[0].passiveMidpointMotion, true);

// Both gates are charges that drain, not counts in a window: they climb while
// the type is being disturbed and fall back on their own. There is no button,
// so they have to be reachable by sweeping and they have to drain slower than
// a real sweep fills them.
assert.ok(STUDIES.every(({ requiredCharacters }) => requiredCharacters >= 500));
assert.ok(STUDIES.every(({ midpointRequired, requiredCharacters }) => midpointRequired > requiredCharacters));
assert.ok(STUDIES.every(({ drainMs }) => drainMs >= 6000));
assert.ok(STUDIES.every(({ midpointDrainMs, drainMs }) => midpointDrainMs >= drainMs));
// A character waits before it can contribute again, so resting on one word
// cannot fill the bar.
assert.ok(STUDIES.every(({ windowMs }) => windowMs >= 2000));
assert.ok(STUDIES.every(({ midpointWindowMs }) => midpointWindowMs >= 2000));
assert.ok(STUDIES.every(({ cursorRadius }) => cursorRadius >= 104));
assert.ok(STUDIES.every(({ midpointRadius }) => midpointRadius >= 116));
assert.ok(STUDIES.every(({ releaseHoldMs }) => releaseHoldMs >= 440));
assert.ok(STUDIES.every(({ midpointReleaseHoldMs }) => midpointReleaseHoldMs >= 560));
assert.ok(STUDIES.every(({ releaseHoldMs, midpointReleaseHoldMs }) => midpointReleaseHoldMs > releaseHoldMs));
assert.ok(STUDIES.every(({ releaseOmega }) => releaseOmega >= 3.9 && releaseOmega <= 4.7));
assert.ok(STUDIES.every(({ midpointReleaseOmega }) => midpointReleaseOmega >= 3.2 && midpointReleaseOmega <= 3.8));
assert.equal(STUDIES[0].durationMs, 2600);
assert.equal(STUDIES[0].resolveMs, 2200);
assert.ok(STUDIES.every(({ midpointName, midpointUnits }) => midpointName?.length > 3 && midpointUnits?.length > 3));
// The page never scrolls, so nothing may describe a gate in prose any more.
assert.ok(STUDIES.every((study) => !("instruction" in study) && !("ageDescription" in study)));

for (const study of STUDIES) {
  const faces = getFaces(study.slug);
  assert.equal(faces.length, 2);
  assert.ok(`${study.headings.join(" ")} ${faces.join(" ")}`.includes("Lawrence"));
  assert.ok(faces.every((face) => face.length > 1300), `${study.slug} needs full personal-site copy on both faces`);
  await stat(resolve(root, "dist", "experiment", study.slug, "index.html"));
  assert.equal((await worker.fetch(new Request(`https://example.test/experiment/${study.slug}`))).status, 200);
  assert.equal((await worker.fetch(new Request(`https://example.test/experiment/${study.slug}/`))).status, 200);
}

await stat(resolve(root, "dist", "server", "index.js"));
assert.equal((await worker.fetch(new Request("https://example.test/not-a-study"))).status, 404);
assert.equal((await worker.fetch(new Request("https://example.test/experiment/nope/extra"))).status, 404);
for (const removedSlug of [
  "calligraphic-pearl",
  "living-ink-scroll",
  "negative-field-loong",
  "dragon-bone",
]) {
  assert.equal(
    (await worker.fetch(new Request(`https://example.test/experiment/${removedSlug}/`))).status,
    404,
  );
}

// Both independently sampled masks must survive the static and worker builds.
const runtimeMasks = [
  ["oriental-loong-mask.avif", "image/avif", 100000],
  ["cursive-long-mask.png", "image/png", 4000],
];
for (const [filename, contentType, minimumBytes] of runtimeMasks) {
  const sourceAsset = await stat(resolve(root, "public", filename));
  assert.ok(sourceAsset.size > minimumBytes, `${filename} looks incomplete`);
  const builtAsset = await stat(resolve(root, "dist", filename));
  assert.equal(builtAsset.size, sourceAsset.size);
  const response = await worker.fetch(new Request(`https://example.test/${filename}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), contentType);
  assert.equal((await response.arrayBuffer()).byteLength, sourceAsset.size);
}

const ogResponse = await worker.fetch(new Request("https://example.test/website-preview.png"));
assert.equal(ogResponse.status, 200);
assert.equal(ogResponse.headers.get("content-type"), "image/png");
const ogBytes = Buffer.from(await ogResponse.arrayBuffer());
const sourceOgBytes = await readFile(resolve(root, "public", "website-preview.png"));
const builtOgBytes = await readFile(resolve(root, "dist", "website-preview.png"));
assert.equal(ogBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(ogBytes.readUInt32BE(16), 1200);
assert.equal(ogBytes.readUInt32BE(20), 630);
assert.deepEqual(ogBytes, sourceOgBytes);
assert.deepEqual(builtOgBytes, sourceOgBytes);
await assert.rejects(stat(resolve(root, "public", "og.png")));
await assert.rejects(stat(resolve(root, "public", "og-ten.png")));

const homeResponse = await worker.fetch(new Request("https://example.test/"));
const homeHtml = await homeResponse.text();
assert.match(homeHtml, /https:\/\/example\.test\/website-preview\.png/);
assert.match(homeHtml, /property="og:image:alt" content="lawrence's website"/);
assert.match(homeHtml, /name="twitter:image:alt" content="lawrence's website"/);
// The site is titled with his name and nothing else.
assert.match(homeHtml, /<title>Lawrence Long<\/title>/);
assert.doesNotMatch(homeHtml, /Loong Basin<\/title>/);
assert.doesNotMatch(homeHtml, /Five|Ten (?:Wind|Letter|Motion)|all (?:five|ten)/i);
assert.doesNotMatch(homeHtml, /__SITE_ORIGIN__|__ASSET_VERSION__/);
assert.match(homeHtml, /styles\.css\?v=[a-f0-9]{12}/);
assert.match(homeHtml, /main\.js\?v=[a-f0-9]{12}/);
const mainResponse = await worker.fetch(new Request("https://example.test/main.js?v=fresh"));
const deployedMain = await mainResponse.text();
assert.equal(mainResponse.headers.get("cache-control"), "no-store");
assert.doesNotMatch(deployedMain, /__ASSET_VERSION__/);
assert.match(deployedMain, /data\.js\?v=[a-f0-9]{12}/);
assert.match(deployedMain, /motion\.js\?v=[a-f0-9]{12}/);
assert.equal((await worker.fetch(new Request("https://example.test/data.js?v=fresh"))).headers.get("cache-control"), "no-store");

// Native baseline and full-size reconstruction preserve the deceptively plain
// HTML appearance; local animation never shrinks a proxy character first.
assert.match(motion, /prepareGlyphTokens/);
assert.match(motion, /glyph-baseline-probe/);
assert.match(motion, /probe\?\.getBoundingClientRect\(\)\.top/);
assert.match(motion, /const computed = style\.font\?\.trim\(\)/);
const localFragmentRenderer = section(motion, "function drawGlyphFragment", "function drawLocalEffect");
assert.match(localFragmentRenderer, /context\.clip\(\)/);
assert.match(localFragmentRenderer, /drawGlyph\(context, glyph, alpha\)/);
assert.doesNotMatch(localFragmentRenderer, /scale\(/);
assert.doesNotMatch(motion, /scale:\s*0\.34/);

// The retained study uses fitted fragments throughout local and global motion.
const fragmentSet = section(motion, "const POSED_FRAGMENT_MODES", "const LOCAL_DYNAMIC_MODES");
for (const mode of fragmentModes) assert.match(fragmentSet, new RegExp(`\"${mode}\"`));
const trajectory = section(motion, "function trajectoryOffset", "function hermite");
const midpointMotion = section(motion, "function midpointEffectOffset", "function renderTransition");
const localMotion = section(motion, "function localPiecePose", "function drawLocalEffect");
for (const mode of expectedModes) {
  const pattern = new RegExp(`case \\"${mode}\\"`);
  assert.match(trajectory, pattern);
  assert.match(midpointMotion, pattern);
  assert.match(localMotion, pattern);
}
const fragmentLayout = section(motion, "function fragmentLayout", "function allFragments");
assert.match(fragmentLayout, /PARTICLE_MODES\.has\(mode\)/);
assert.match(fragmentLayout, /sampleGlyphInk\(/);
assert.match(fragmentLayout, /detail === "transition"/);
assert.match(fragmentLayout, /clamp\(area \* 0\.055, 8, 28\)/);
assert.match(fragmentLayout, /particle:\s*true/);
assert.match(fragmentLayout, /glyphKey:\s*glyph\.key/);
assert.match(fragmentLayout, /pieceIndex/);
assert.match(fragmentLayout, /sourceId:\s*`\$\{glyph\.key\}:/);
assert.match(motion, /fragmentLayout\(glyph, mode, shapeCache, "transition"\)/);
assert.match(motion, /0\.618033988749895/);

// Both assets are loaded together, sampled independently, and tagged so every
// token knows whether it belongs to dragon anatomy or calligraphy. Study 01
// uses one pure layer per randomly chosen attractor.
const maskLoader = section(motion, "function loadSamplingMask", "function wait");
assert.match(maskLoader, /Promise\.all\(/);
assert.match(maskLoader, /load\("\/oriental-loong-mask\.avif"\)/);
assert.match(maskLoader, /load\("\/cursive-long-mask\.png"\)/);
assert.match(maskLoader, /\.catch\(\(\) => null\)/);
assert.match(maskLoader, /\{ dragon, calligraphy \}/);
assert.match(maskLoader, /samplingMaskCache\.has\(kind\)/);
assert.match(motion, /await loadSamplingMask\(study\.midpoint\)/);
const midpointSampler = section(motion, "function maskCandidates", "function makeTransitionTokens");
assert.match(midpointSampler, /candidates\.push\(\{ x:[^}]*motif \}\)/);
assert.match(midpointSampler, /maskCandidates\([\s\S]*?dragonImage,[\s\S]*?"dragon"/);
assert.match(midpointSampler, /maskCandidates\([\s\S]*?maskImages\?\.calligraphy,[\s\S]*?"calligraphy"/);
assert.match(midpointSampler, /const cacheKey = `\$\{kind\}:\$\{count\}:/);
for (const kind of expectedMidpoints.slice(1)) assert.match(midpointSampler, new RegExp(`\"${kind}\"`));
assert.match(midpointSampler, /"oriental-dragon"[^}]*ratio:\s*0/);
assert.match(midpointSampler, /"cursive-long"[\s\S]*?ratio:\s*1/);
assert.match(midpointSampler, /dragonCount\s*\?\s*maskCandidates/);
assert.match(midpointSampler, /calligraphyCount\s*\?\s*maskCandidates/);
assert.match(midpointSampler, /const step = count > 16000 \? 1 : count > 3200 \? 2 : 3/);
assert.match(motion, /midpointRole:\s*mid\.motif/);
assert.match(motion, /motif:\s*token\.midpointRole/);
assert.match(midpointSampler, /drawLoongMask\(context, maskWidth, maskHeight\)/);

// Release is a true hold followed by an analytic critically damped spring. It
// must not use the old settling flag or an exponential level interpolation.
const spring = section(motion, "function criticalSpringState", "function hash");
assert.match(spring, /const displacement = level - target/);
assert.match(spring, /const combined = velocity \+ omega \* displacement/);
assert.match(spring, /level:/);
assert.match(spring, /velocity:/);
assert.doesNotMatch(motion, /settlingAt/);
const localRelease = section(motion, "function drawLocal", "function processPoint");
assert.match(localRelease, /releaseStartedAt/);
assert.match(localRelease, /study\.releaseHoldMs/);
assert.match(localRelease, /effect\.target = holding \? effect\.releaseLevel : 0/);
assert.match(localRelease, /criticalSpringState\(/);
assert.match(localRelease, /effect\.levelVelocity = spring\.velocity/);
assert.doesNotMatch(localRelease, /effect\.level \+=.*Math\.exp|responseMs/);
assert.match(motion, /function reserveEffectSlot/);
assert.match(
  localRelease,
  /reserveEffectSlot\([\s\S]*?performanceProfile\.localEffectSoftLimit[\s\S]*?performanceProfile\.localEffectHardLimit/,
);
assert.doesNotMatch(localRelease, /pruneReleasedEffects/);
assert.match(localRelease, /releaseStartedAt:\s*0/);
assert.match(localRelease, /levelVelocity:\s*0/);
const midpointRelease = section(motion, "function disturbMidpointToken", "function applyFace");
assert.match(midpointRelease, /midpointReleaseHoldMs \|\| study\.releaseHoldMs/);
assert.match(midpointRelease, /midpointReleaseOmega \|\| study\.releaseOmega/);
assert.match(midpointRelease, /criticalSpringState\(/);
assert.match(midpointRelease, /effect\.levelVelocity = spring\.velocity/);
assert.match(
  midpointRelease,
  /reserveEffectSlot\([\s\S]*?performanceProfile\.midpointEffectSoftLimit[\s\S]*?performanceProfile\.midpointEffectHardLimit/,
);
assert.match(midpointRelease, /retireMidpointEffect,[\s\S]*?\)\) return false/);
assert.match(motion, /function retireMidpointEffect/);
assert.match(motion, /retiredMidpointEffects\.set\(index, effect\)/);
assert.match(motion, /const retiredMidpointEffects = new Map/);
assert.match(motion, /oldestRetiredKey[\s\S]*retiredMidpointEffects\.delete\(oldestRetiredKey\)/);
assert.doesNotMatch(midpointRelease, /find\(\(\[, effect\]\) => effect\.releaseStartedAt > 0\)/);
assert.doesNotMatch(midpointRelease, /effect\.level \+=.*Math\.exp|responseMs/);

// The midpoint motif is an indefinite stable state: only its high interaction
// gate (or the explicit control) may advance to the next HTML page.
assert.match(motion, /const MIDPOINT_PROGRESS = 0\.46/);
assert.match(motion, /phase = "midpoint"/);
assert.equal(
  [...motion.matchAll(/charge >= chargeTarget\(\)/g)].length,
  2,
  "both stable and midpoint transitions must use the shared charge target",
);
assert.doesNotMatch(
  motion,
  /charge >= study\.(?:requiredCharacters|midpointRequired)/,
);
assert.match(
  motion,
  /activeScene\?\.tokens\?\.length \|\| activeScene\?\.baseTokenCount/,
);
assert.equal(particleScaledThreshold(3000, 10000), 3000);
assert.equal(particleScaledThreshold(3000, 1440), 432);
assert.equal(particleScaledThreshold(3000, 1764), 529);
assert.equal(particleScaledThreshold(3000, 2160), 648);
assert.equal(particleScaledThreshold(3000, 12000), 3000);
assert.equal(particleScaledThreshold(3000, 0), 3000);
assert.equal(particleScaledThreshold(620, 900, 1200), 465);
assert.equal(captureReferenceParticleCount([
  { key: "text-a" },
  { key: "text-b" },
  {
    kind: "image",
    imageGroupKey: "photo",
    imageReferenceParticleCount: 260,
  },
  {
    kind: "image",
    imageGroupKey: "photo",
    imageReferenceParticleCount: 260,
  },
  {
    kind: "image",
    imageGroupKey: "logo",
    imageReferenceParticleCount: 1,
  },
]), 263);
const chargeTargetSource = section(
  motion,
  "  function chargeTarget() {",
  "  function drainCharge(now) {",
);
assert.match(chargeTargetSource, /quality\.tier !== "mobile"/);
assert.match(chargeTargetSource, /captures\[currentFace\]\?\.length/);
assert.match(chargeTargetSource, /captureReferenceCounts\[currentFace\]/);
const captureRebuildSource = section(
  motion,
  "  function rebuildCaptures(",
  "  function rebuildMidpointSceneForResize()",
);
assert.match(captureRebuildSource, /quality\.tier === "mobile" && phase === "stable"/);
assert.match(captureRebuildSource, /charge = disturbanceProgress \* chargeTarget\(\)/);
const midpointResizeSource = section(
  motion,
  "  function rebuildMidpointSceneForResize()",
  "  function animateProgress(",
);
assert.match(midpointResizeSource, /charge = disturbanceProgress \* chargeTarget\(\)/);
assert.match(midpointResizeSource, /midpointEffects\.clear\(\)/);
assert.match(midpointResizeSource, /retiredMidpointEffects\.clear\(\)/);
assert.match(midpointResizeSource, /midpointMemory\.clear\(\)/);
assert.match(motion, /if \(phase === "midpoint"\) void resolveMidpoint\(\)/);
assert.match(motion, /animateProgress\(scene, 0, MIDPOINT_PROGRESS, study\.durationMs\)/);
assert.match(motion, /animateProgress\(scene, MIDPOINT_PROGRESS, 1, study\.resolveMs, true\)/);
const midpointEntry = section(motion, "async function transitionToMidpoint", "async function resolveMidpoint");
assert.doesNotMatch(midpointEntry, /setTimeout\([^)]*resolveMidpoint|animateProgress\(scene, MIDPOINT_PROGRESS, 1/);

// Study 01 chooses and locks one of two pure attractors. The already-random
// queued variant is prewarmed alone, cached separately, and remains alive.
assert.match(motion, /function chooseMidpointVariant/);
assert.match(motion, /crypto\?\.getRandomValues/);
assert.match(motion, /let queuedMidpoint = chooseMidpointVariant\(midpointVariants\)/);
assert.match(motion, /const chosenMidpoint = queuedMidpoint/);
assert.match(motion, /function sceneKey\(sourceFace, midpointKind\)/);
assert.match(motion, /`\$\{sourceFace\}:\$\{midpointKind\}`/);
assert.match(motion, /function prewarmQueuedScene/);
assert.doesNotMatch(motion, /for \(const \{ id \} of midpointVariants\) void scheduleScene/);
assert.match(motion, /function passiveMidpointOffset/);
assert.match(motion, /function preparePassiveMidpoint/);
assert.match(motion, /function passiveMidpointEnvelope/);
assert.match(motion, /function midpointVisualAnchor/);
assert.match(motion, /const queryRadius = radius \+ MIDPOINT_MAX_VISUAL_DISPLACEMENT/);
assert.match(motion, /retiredMidpointEffects\?\.get|retiredEffects\?\.get/);
assert.match(motion, /options\.allowPassive !== false/);
assert.match(motion, /equilibriumAlive[\s\S]*requestAnimationFrame\(drawMidpoint\)/);
assert.match(motion, /"cursive-long"[\s\S]*?size:\s*1\.25/);
assert.match(motion, /function rebuildMidpointSceneForResize/);
assert.match(motion, /phase === "midpoint" && activeScene/);

// Live handoff is committed in one animation frame. Exact fragment identity,
// position, rotation, and velocity seed Hermite motion before local effects are
// cleared; there is no snapshot fade or reset to clean type.
assert.match(motion, /phase = "arming"/);
assert.match(motion, /const liveHandoff = transitioning && phase === "arming"/);
assert.match(motion, /function seedSceneHandoff/);
assert.match(motion, /const localPiece = effect\.fragments\[piece\.pieceIndex\]/);
assert.match(motion, /sourceId:\s*piece\.sourceId/);
assert.match(motion, /x:\s*sourceCenter\.x \+ pose\.x/);
assert.match(motion, /y:\s*sourceCenter\.y \+ pose\.y/);
assert.match(motion, /rotation:\s*pose\.rotation/);
assert.match(motion, /vx:\s*\(futurePose\.x - pose\.x\) \/ epsilon/);
assert.match(motion, /vy:\s*\(futurePose\.y - pose\.y\) \/ epsilon/);
assert.match(motion, /angularVelocity:/);
assert.match(motion, /scene\.tokens\.length = scene\.baseTokenCount/);
assert.match(motion, /knownSourceIds/);
assert.match(motion, /scene\.handoffRects/);
assert.match(motion, /const source = handoff \|\| token\.sourceCenter/);
assert.match(motion, /hermite\(from\.x, handoff\?\.vx \|\| 0/);
assert.match(motion, /hermite\(from\.y, handoff\?\.vy \|\| 0/);
assert.doesNotMatch(motion, /captureHandoffAtlas|handoffAtlas|handoffBlend/);
const transitionEntry = section(motion, "async function transitionToMidpoint", "async function resolveMidpoint");
const seedIndex = transitionEntry.indexOf("seedSceneHandoff");
const firstGlobalRenderIndex = transitionEntry.indexOf("renderTransition");
const effectClearIndex = transitionEntry.indexOf("effects.clear");
assert.ok(seedIndex >= 0 && firstGlobalRenderIndex > seedIndex, "handoff must seed before the first global frame");
assert.ok(effectClearIndex > firstGlobalRenderIndex, "local effects must remain alive through the first global frame");
assert.match(transitionEntry, /root\.dataset\.handoff = "commit"/);
assert.match(motion, /Math\.sin\(Math\.PI \* clamp\(t\)\) \*\* 2/);
const globalRenderer = section(motion, "function renderTransition", "function sampleGlyphInk");
assert.match(globalRenderer, /sourcePageAlpha/);
assert.match(globalRenderer, /negativeHeartPieces/);
assert.match(globalRenderer, /fillRect\(rect\.left, rect\.top, rect\.width, rect\.height\)/);
assert.doesNotMatch(globalRenderer, /rect\.left - 1|rect\.top - 1/);
// The global frame still paints an opaque page beneath the fragments; it is
// now the paper colour rather than pure white.
assert.match(globalRenderer, /context\.fillStyle = PAPER;/);
assert.doesNotMatch(globalRenderer, /const tokenOpacity = 1 -/);

// Scroll updates every captured baseline and live fragment, then invalidates the
// scene cache and rebuilds without resetting interaction state.
const scrollHandler = section(motion, "function onLayoutChange", "function onMotionPreference");
assert.match(scrollHandler, /phase !== "stable" && phase !== "arming"/);
assert.match(scrollHandler, /pendingCapture = true/);
assert.match(scrollHandler, /const deltaY = scrollPositions\[face\] - nextScroll/);
assert.match(scrollHandler, /glyph\.rect\.top \+= deltaY/);
assert.match(scrollHandler, /glyph\.rect\.bottom \+= deltaY/);
assert.match(scrollHandler, /glyph\.baseline \+= deltaY/);
assert.match(scrollHandler, /for \(const fragment of effect\.fragments\) fragment\.y \+= deltaY/);
assert.match(scrollHandler, /invalidateScenes\(\)/);
assert.match(scrollHandler, /rebuildCaptures\(false, true\)/);
assert.doesNotMatch(scrollHandler, /resetLocal\(/);
assert.match(motion, /root\.addEventListener\("scroll", onLayoutChange, \{ capture: true, passive: true \}\)/);
assert.match(motion, /root\.removeEventListener\("scroll", onLayoutChange, true\)/);
assert.match(motion, /refreshPendingCapture\(currentFace, midpointKind\)/);
assert.match(motion, /root\.addEventListener\("wheel", onTransientScrollInput, \{ passive: false \}\)/);

// The interaction remains invisible and the page cannot accidentally select
// text. Default typography and a white background preserve the old-HTML shell.
assert.match(styles, /-webkit-user-select:\s*none/);
assert.match(styles, /user-select:\s*none/);
assert.match(styles, /cursor:\s*default/);
assert.doesNotMatch(styles, /user-select:\s*text|cursor:\s*text/);
assert.doesNotMatch(motion, /cursorField|function drawField/);
assert.match(styles, /data-owner="canvas"[^}]*\.semantic-pages[\s\S]*?opacity:\s*0/);
assert.match(styles, /font:\s*16px\/normal "Times New Roman"/);
assert.doesNotMatch(styles, /perspective|translateZ|linear-gradient/i);
const focusStyle = section(
  styles,
  ".matter-experience:focus-visible {",
  ".semantic-pages {",
);
assert.doesNotMatch(focusStyle, /dotted/);
assert.match(focusStyle, /\.matter-experience:focus-visible \.page-motto/);

assert.match(motion, /const MAX_POINTER_SAMPLES = 20/);
assert.match(motion, /function limitPointerSamples/);
assert.match(motion, /const endpoint = points\.at\(-1\)/);
assert.match(motion, /limited\.push\(endpoint\)/);
const pointerSampleSource = section(
  motion,
  "  function pointerSamples(event",
  "  function onPointerMove(event)",
);
assert.match(pointerSampleSource, /if \(maximum < MAX_POINTER_SAMPLES\)/);
assert.match(pointerSampleSource, /sourceEvents\.map/);
assert.match(pointerSampleSource, /output\[output\.length - 1\] = endpoint/);
assert.match(
  motion,
  /pointerSamples\(\s*event,\s*performanceProfile\.pointerSamples/,
);
assert.match(
  motion,
  /pendingPointerPoints = limitPointerSamples\(\s*pendingPointerPoints,\s*performanceProfile\.pointerSamples/,
);
assert.match(motion, /const MAX_NEW_VISUALS_PER_FRAME = 2/);
assert.match(motion, /const MIDPOINT_EFFECT_HARD_LIMIT = 160/);
assert.match(motion, /const MIDPOINT_RETIRED_EFFECT_LIMIT = 288/);
assert.match(motion, /const MIDPOINT_RETIRE_MS = 360/);
assert.match(motion, /const MAX_NEW_MIDPOINT_VISUALS_PER_FRAME = 12/);
assert.match(motion, /Give the live cursor endpoint first claim/);
assert.match(motion, /fast swipe that ends in white space/);
assert.match(motion, /points\.length - 1; index >= 0/);
assert.match(motion, /Existing effects are always/);
assert.match(motion, /function retireLocalEffect/);
assert.match(motion, /const LOCAL_RETIRED_EFFECT_LIMIT = 56/);
assert.match(motion, /const LOCAL_RETIRE_MS = 420/);
assert.match(motion, /retiredEffects\.set\(key, effect\)/);
assert.match(
  motion,
  /visibleLocalEffects\(\s*\[\.\.\.retiredEffects\.values\(\), \.\.\.effects\.values\(\)\],\s*performanceProfile\.localEffectHardLimit/,
);
assert.match(
  motion,
  /lastMidpointPointerFlushAt[\s\S]*?< performanceProfile\.midpointActiveFrameMs/,
);
// The midpoint keeps requesting frames while the equilibrium breathes, while
// the arrival flash decays, and while the still point is being held.
assert.match(motion, /retiredMidpointEffects\.size[\s\S]{0,60}\|\| equilibriumAlive/);
assert.match(motion, /const visualAnchorCache = new Map/);
assert.match(motion, /const nearbyByPoint = points\.map/);

const freshEffects = new Map(Array.from({ length: 40 }, (_, index) => [index, {
  releaseStartedAt: 1000,
  target: 0.9,
  level: 0.9,
  levelVelocity: 0,
}]));
assert.equal(reserveEffectSlot(freshEffects, 28, 40, 1001, 620), false);
assert.equal(freshEffects.size, 40, "fresh release tails must survive without a retirement tier");

const pressureEffects = new Map(freshEffects);
let retiredEffect = null;
assert.equal(reserveEffectSlot(
  pressureEffects,
  28,
  40,
  1001,
  620,
  (key, effect) => { retiredEffect = { key, effect }; },
), true);
assert.equal(pressureEffects.size, 39, "local pressure should move one released effect into retirement");
assert.ok(retiredEffect?.effect, "retired effects must remain available for a smooth visual return");

const heldEffects = new Map(Array.from({ length: 40 }, (_, index) => [index, {
  releaseStartedAt: 0,
  target: 0.25 + index / 100,
  level: 0.8,
  levelVelocity: 0,
  lastInsideAt: 1000 + index,
}]));
let weakestRetired = null;
assert.equal(reserveEffectSlot(
  heldEffects,
  28,
  40,
  1100,
  620,
  (key, effect) => { weakestRetired = { key, effect }; },
), true);
assert.equal(weakestRetired?.key, 0, "pressure retirement should choose the weakest held effect");
assert.equal(heldEffects.size, 39);

const reclaimableEffects = new Map(freshEffects);
reclaimableEffects.set(0, {
  releaseStartedAt: 1000,
  target: 0,
  level: 0.001,
  levelVelocity: 0.001,
});
assert.equal(reserveEffectSlot(reclaimableEffects, 28, 40, 2000, 620), true);
assert.equal(reclaimableEffects.has(0), false, "only a settled post-hold tail should be reclaimed");
reclaimableEffects.set("new", { releaseStartedAt: 0, target: 1, level: 0 });
assert.ok(reclaimableEffects.size <= 40, "detailed effect admission must remain hard-bounded");

const longPointerPath = Array.from({ length: 100 }, (_, index) => ({ x: index * 7, y: index * 11 }));
const limitedPointerPath = limitPointerSamples(longPointerPath);
assert.ok(limitedPointerPath.length <= 20);
assert.deepEqual(limitedPointerPath.at(-1), longPointerPath.at(-1));
const limitedMobilePointerPath = limitPointerSamples(longPointerPath, 6);
assert.equal(limitedMobilePointerPath.length, 6);
assert.deepEqual(limitedMobilePointerPath.at(-1), longPointerPath.at(-1));
assert.match(motion, /Preserve the last queued sample/);
assert.match(quality, /export const FULL_GLOBAL_DPR_CAP = 1\.3/);
assert.match(motion, /setupCanvas\(globalCanvas, quality\.globalDprCap\)/);
assert.match(motion, /setupCanvas\(localCanvas, quality\.localDprCap\)/);
assert.match(motion, /word\.className = "glyph-word"/);
assert.match(motion, /function clearLocalDirty/);
assert.match(motion, /if \(shown !== lastProgressText\)/);
assert.doesNotMatch(main, /Five [^`]*(?:studies|experiments)|all five/i);
assert.doesNotMatch(main, /const previous = STUDIES|const next = STUDIES/);
assert.match(main, /await renderStudy\(STUDIES\[0\]\)/);
assert.match(main, /data-owner="dom"/);
assert.doesNotMatch(main, /all ten|Ten wind and type/i);

// The paper substrate has exactly one definition. styles.css mirrors it, and
// the canvases must use the shared constant rather than a literal, or the
// erase rectangles under hovered glyphs would not match the page behind them.
assert.equal(PAPER, "#ffffff");
assert.match(styles, /--paper:\s*#ffffff/);
assert.match(styles, /--ink:\s*#000000/);
assert.doesNotMatch(motion, /fillStyle = "#ffffff"|fillStyle = "#fff"/);
// The page is plain white; the paper treatment is gone.
assert.doesNotMatch(styles, /paper-grain/);
assert.doesNotMatch(main, /paper-grain/);
assert.match(styles, /\.default-page \{[\s\S]*?background: transparent/);

// Ink accumulation and the still point were both removed; nothing should be
// left referring to them.
assert.doesNotMatch(motion, /residue|focusRing|midpointFocus|drawFocusRing/i);
assert.doesNotMatch(styles, /residue-canvas|restore-control/);
assert.doesNotMatch(main, /residue-canvas|restore-control/);

// The page corrupts as it sits and is cleaned by touching it. Corruption is
// drawn entirely in overlay pseudo-elements: the real character stays in the
// DOM, so the canvas keeps exploding the *clean* glyph and restoring is just
// dropping attributes.
// The clock loops rather than measuring out a single lifetime.
assert.match(aging, /export const REVOLUTION_MS = /);
assert.match(motion, /ageState\.turns \* 360/);
// Corruption starts one character at a time and accelerates: a cube root of a
// uniform draw makes the count of started characters grow as time cubed.
assert.match(aging, /Math\.cbrt\(uniform\) \* ONSET_SPAN_MS/);
assert.match(aging, /function onsetFrom/);
assert.match(aging, /dataset\.corrupt/);
assert.doesNotMatch(aging, /style\.color|style\.opacity|style\.visibility/);
// The advance width is pinned before any overlay is attached, or a corrupting
// page would reflow every line it touched.
const pinFn = section(aging, "  function pin(record) {", "  function applyLevel");
assert.match(pinFn, /style\.width = /);
// A refit changes the type size, which makes every pinned width wrong.
assert.match(aging, /remeasure\(\)/);
assert.match(motion, /aging\?\.remeasure\(\)/);
// `fitFaces` runs once before `aging` exists, so it must not reference it —
// optional chaining does not protect against a temporal dead zone.
const fitFn = section(motion, "  function fitFaces() {", "  layers.forEach((layer, index) => prepareGlyphTokens");
assert.doesNotMatch(fitFn, /aging/);

// Hovering restores. The explode path is what records a clean-up, and each
// restored character winds the clock back.
assert.match(motion, /restoreKeys\.add\(glyph\.key\)/);
assert.match(motion, /aging\?\.restore\(restoreKeys\)/);
const restoreFn = section(aging, "    restore(keys) {", "    // Passing into the attractor");
assert.match(aging, /const RESTORE_REWIND_MS = 500;/);
assert.match(restoreFn, /elapsed = Math\.max\(0, elapsed - healed \* RESTORE_REWIND_MS\)/);
// Corruption is per-character state that accumulates, not a function of the
// global clock — that is what lets a cleaned character stay clean instead of
// being re-corrupted on the very next tick.
// A restored character has its onset pushed past now, so it stays clean and
// then begins again from nothing instead of being re-corrupted next tick.
const restoreRecordFn = section(aging, "  function restoreRecord(record, reschedule = true) {", "  function publish(");
assert.match(restoreRecordFn, /record\.onset = elapsed \+ Math\.cbrt\(Math\.random\(\)\)/);
// Pointer disturbance still only heals; deliberate clock winding is the sole
// direct age adjustment.
assert.doesNotMatch(aging, /STRESS|stress/i);
const agingSetElapsed = section(
  aging,
  "    setElapsed(next, { immediate = false } = {}) {",
  "    // Passing into the attractor",
);
assert.match(agingSetElapsed, /Number\.isFinite\(value\)/);
assert.match(agingSetElapsed, /elapsed = Math\.max\(0, value\)/);
assert.match(agingSetElapsed, /lastTickAt = performance\.now\(\)/);
assert.match(
  agingSetElapsed,
  /immediate \? Number\.POSITIVE_INFINITY : maxWritesPerTick,[\s\S]*?immediate \? Number\.POSITIVE_INFINITY : undefined/,
);
assert.match(agingSetElapsed, /settled: result\.settled/);
assert.match(
  agingSetElapsed,
  /reconcile\(\)[\s\S]*?reconcileLevels\(maxWritesPerTick, Number\.POSITIVE_INFINITY\)/,
);
assert.doesNotMatch(agingSetElapsed, /maxWritesPerTick \* 2/);
assert.match(agingSetElapsed, /publish\(\{ settle: true, settled: result\.settled \}\)/);

// Reset returns every character and winds the hand to zero.
const resetFn = section(aging, "    reset() {", "    get state()");
assert.match(resetFn, /elapsed = 0/);
assert.match(resetFn, /restoreRecord\(record, false\)/);

// The glitch itself: a slice cut out of the character and displaced, not a
// symbol laid over it. The eraser band and the displaced copy must both exist.
assert.match(styles, /\.glyph-ink\[data-corrupt\]::before \{[\s\S]*?background: var\(--paper\)/);
assert.match(styles, /\.glyph-ink\[data-corrupt\]::after \{[\s\S]*?content: attr\(data-glyph\)/);
assert.match(styles, /clip-path: inset\(/);
// Displacement is em-relative so a heading and a footnote tear by the same
// proportion of their own size.
const corruptBlock = section(styles, "/* Corruption.", "/* The photograph floats");
assert.doesNotMatch(corruptBlock, /\d+(\.\d+)?px/);
// Only a bounded, rotating subset animates.
assert.match(styles, /\.glyph-ink\[data-corrupt\]\[data-live\]/);
assert.match(aging, /const LIVE_LIMIT = /);
assert.match(aging, /function rotateLive/);
assert.match(aging, /function clearLive\(\)/);
assert.match(aging, /if \(!active\) clearLive\(\)/);
assert.match(
  section(aging, "    stop() {", "    // Whether the DOM page"),
  /clearLive\(\)/,
);
const agingTick = section(aging, "  function tick() {", "  function schedule() {");
assert.match(agingTick, /if \(active\) publish\(\)/);
// Steps timing throughout: a glitch that eases is a wobble.
assert.match(corruptBlock, /steps\(1, end\)/);
// The cut moves with a transform; `top` would be a layout change every step.
const cutKeyframes = section(styles, "@keyframes glyph-cut", "@keyframes glyph-slip");
assert.match(cutKeyframes, /translateY/);
assert.doesNotMatch(cutKeyframes, /top:/);

// The clock: one hand, one full turn per lifetime, in cumulative degrees so a
// reset can travel backwards through the turn rather than the short way round.
assert.match(motion, /setProperty\("--hand-age"/);
assert.doesNotMatch(motion, /hand-lifetime/);
assert.match(styles, /rotate: calc\(var\(--hand-age, 0\) \* 1deg\)/);
assert.match(styles, /\.age-clock\[data-rewind="true"\]/);
assert.equal((main.match(/age-clock-hand/g) || []).length, 1, "the clock has exactly one hand");
assert.match(main, /class="age-clock-control"[\s\S]*?role="spinbutton"/);
assert.match(main, /aria-valuemin="0"/);
assert.match(main, /clockControl: root\.querySelector\("\.age-clock-control"\)/);
const degrees = (value) => value * Math.PI / 180;
assert.ok(Math.abs(wrappedClockAngleDelta(degrees(350), degrees(10)) - degrees(20)) < 1e-10);
assert.ok(Math.abs(wrappedClockAngleDelta(degrees(10), degrees(350)) + degrees(20)) < 1e-10);
{
  const revolution = 22000;
  let elapsed = 0;
  for (let quarter = 0; quarter < 8; quarter += 1) {
    elapsed = elapsedAfterClockDelta(elapsed, Math.PI / 2);
  }
  assert.equal(elapsed, revolution * 2);
  for (let quarter = 0; quarter < 8; quarter += 1) {
    elapsed = elapsedAfterClockDelta(elapsed, -Math.PI / 2);
  }
  assert.equal(elapsed, 0);
  assert.equal(elapsedAfterClockDelta(0, -Math.PI / 2), 0);
  assert.ok(elapsedAfterClockDelta(0, Math.PI / 12) > 0);
}
assert.match(styles, /\.age-clock-control \{[\s\S]*?touch-action: none/);
assert.match(
  styles,
  /\.age-clock-control\[data-dragging="true"\] \.age-clock-hand,[\s\S]*?\.age-clock-control\[data-clock-sync="true"\] \.age-clock-hand \{[\s\S]*?transition: none/,
);
assert.match(styles, /\.age-clock-control:focus-visible/);
const disabledClockStyle = section(
  styles,
  '.age-clock-control[aria-disabled="true"] {',
  ".age-clock {",
);
assert.match(disabledClockStyle, /cursor: not-allowed/);
assert.doesNotMatch(disabledClockStyle, /pointer-events: none/);
assert.match(motion, /setPointerCapture\(event\.pointerId\)/);
assert.match(motion, /releasePointerCapture\(pointerId\)/);
assert.match(motion, /getCoalescedEvents\?\.\(\)/);
assert.match(motion, /phase === "stable"[\s\S]*?!transitioning[\s\S]*?!rewindingAge/);
assert.match(motion, /requestAnimationFrame\(flushClockDragFrame\)/);
assert.match(motion, /aging\?\.setElapsed\(clockPendingElapsed\)/);
assert.match(
  motion,
  /const previousElapsed = clockPendingElapsed;[\s\S]*?Math\.abs\(clockPendingElapsed - previousElapsed\) > 0\.01/,
);
assert.match(motion, /requestAnimationFrame\(reconcileClockAgeFrame\)/);
assert.match(motion, /const textSettled = aging\?\.reconcile\(\) \?\? true/);
assert.match(motion, /function holdClockHandAtPointer\(\)[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{/);
assert.doesNotMatch(motion, /const aging = reducedMotion\.matches \? null/);
const clockCancel = section(
  motion,
  "  function onClockPointerCancel(event) {",
  "  function onClockLostPointerCapture(event) {",
);
assert.doesNotMatch(clockCancel, /queueClockPointer/);
assert.match(clockCancel, /endClockDrag\(\)/);
const clockPointerDown = section(
  motion,
  "  function onClockPointerDown(event) {",
  "  function onClockPointerMove(event) {",
);
assert.match(clockPointerDown, /catch \{[\s\S]*?endClockDrag\(\)/);
assert.match(
  clockPointerDown,
  /clockPendingElapsed = aging\?\.state\?\.elapsed \?\? clockPendingElapsed/,
);
const clockKeyboard = section(
  motion,
  "  function onClockKeyDown(event) {",
  "  // There is no button",
);
assert.ok(
  clockKeyboard.indexOf("applyPendingRestorations();")
    < clockKeyboard.indexOf("const elapsed = aging?.state?.elapsed || 0"),
  "keyboard winding must preserve a pending hover rewind",
);
assert.match(clockKeyboard, /if \(!clockCanInteract\(\) \|\| clockDragging\) return/);
assert.doesNotMatch(clockKeyboard, /immediate: true/);
// The readout is a duration, not a percentage.
assert.match(motion, /this page is \$\{Math\.floor\(whole \/ 60\)\}/);
assert.doesNotMatch(motion, /passage|burden/i);
// The motto is the argument the whole page is making.
assert.match(main, /aging is information corruption\./);

// The reset happens on the way *into* the attractor, not on the way out.
const enterBody = section(motion, "async function transitionToMidpoint", "async function resolveMidpoint");
assert.ok(
  enterBody.indexOf("transitioning = true") < enterBody.indexOf("endClockDrag({"),
  "transition entry must lock the dial before final reconciliation",
);
assert.ok(
  enterBody.indexOf("await reconcileClockAge({")
    < enterBody.indexOf("flushClockCaptureSync({ allowTransition: true })"),
  "transition entry must await reconciliation before capture",
);
assert.match(enterBody, /resetCellState\(\)/);
assert.match(enterBody, /resetCellState\(\);[\s\S]*?refreshSceneTargetAtlas\(scene, targetFace\)/);
const leaveBody = section(motion, "async function resolveMidpoint", "function resetCellState");
assert.doesNotMatch(leaveBody, /resetCellState\(\)/);

// There is still no transition button. Filling the meter is the pointer path
// through; the clock adjusts age but never advances the page.
assert.doesNotMatch(main, /transition-control|assemble /);
assert.doesNotMatch(motion, /transitionButton|assembleButton|restoreButton/);
assert.match(main, /loong:advance/);
assert.match(motion, /root\.addEventListener\("loong:advance", onAdvance\)/);

// The disturbance meter is a draining charge, present in every state.
assert.match(styles, /width: calc\(var\(--disturb, 0\) \* 100%\)/);
assert.match(motion, /function drainCharge/);
assert.match(motion, /function addCharge/);
assert.match(main, /class="disturb-track"/);

// The page is one screen. Type is fitted to the box; nothing scrolls.
assert.match(styles, /\.default-page \{[\s\S]*?overflow: hidden/);
assert.match(motion, /function fitFace/);
assert.match(motion, /page\.scrollHeight > page\.clientHeight/);
assert.match(motion, /const allowsVerticalScroll = getComputedStyle\(page\)\.overflowY === "auto"/);

// The explanatory block is gone; the instruments say it now.
assert.doesNotMatch(main, /experiment-hint/);
assert.doesNotMatch(styles, /experiment-hint/);

// Both pages are titled, and neither carries the old filename label or the
// name in the corner.
assert.deepEqual(STUDIES[0].headings, ["Lawrence Long, Page 1", "Lawrence Long, Page 2"]);
assert.doesNotMatch(main, /study\.labels|<small>/);
assert.doesNotMatch(main, /<a href="\/">Lawrence Long<\/a>/);
assert.ok(STUDIES.every((study) => !("labels" in study)));

// The photographs are cut into tiles and pushed through the same pipeline as
// text, so they explode under the cursor and land in the dragon.
assert.match(motion, /img\[data-diffuse\]/);
assert.match(photo, /export const IMAGE_TILE_TARGET = /);
assert.match(motion, /glyph\.kind === "image"/);
assert.match(motion, /image\.decode\(\)/);
for (const [face, src] of [[0, "/lawrence-1.jpg"], [1, "/lawrence-2.jpg"]]) {
  assert.ok(getFaces(STUDIES[0].slug)[face].includes(src), `face ${face} needs its photograph`);
  await stat(resolve(root, "public", src.slice(1)));
  const response = await worker.fetch(new Request(`https://example.test${src}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
}
for (const photoMarkup of data.matchAll(/<img src="\/lawrence-[^"]+"[^>]*>/g)) {
  assert.doesNotMatch(photoMarkup[0], /data-diffuse-whole/);
}
assert.ok(/boris tsang/i.test(getFaces(STUDIES[0].slug)[1]));

// The first rendered markup already contains the real age. It is refreshed
// before the first await and again before tokenization, so slow font, image, or
// mask loading can never expose the old zero-value placeholder.
assert.equal(
  formatLiveAge(BIRTH_MS + TROPICAL_YEAR_MS * 22.5),
  "22.50000000",
);
assert.match(formatLiveAge(), /^\d{2}\.\d{8}$/);
assert.notEqual(formatLiveAge(), "00.00000000");
const renderedAge = getFaces(STUDIES[0].slug)[0].match(/class="live-age">([^<]+)</)?.[1];
assert.match(renderedAge, /^\d{2}\.\d{8}$/);
assert.ok(Math.abs(Number(renderedAge) - Number(formatLiveAge())) < 0.000001);
assert.doesNotMatch(data, /00\.00000000/);
assert.match(data, /formatLiveAge\(\)/);
const mountPrelude = section(
  motion,
  "export async function mountMatterExperience({",
  "  // Tiles are cut from the laid-out box",
);
assert.match(mountPrelude, /seedLiveAge\(\);\s*await document\.fonts\?\.ready/);
const tokenizationPrelude = section(
  motion,
  "  const midpointMask = await loadSamplingMask",
  "  fitFaces();",
);
assert.ok(tokenizationPrelude.indexOf("seedLiveAge();") < tokenizationPrelude.indexOf("prepareGlyphTokens("));
assert.match(
  section(motion, "  function refreshLiveAge() {", "  function writeAgeLine(seconds) {"),
  /const text = formatLiveAge\(\)/,
);
assert.match(motion, /function refreshLiveAge\(\)[\s\S]*?\}\s*refreshLiveAge\(\);/);
// The fixed-width digits are still tokenised like everything else, so the age
// corrupts and joins the dragon rather than sitting outside the system.
assert.match(motion, /\.live-age \.glyph-token/);
assert.ok(getFaces(STUDIES[0].slug)[0].includes('class="live-age"'));
assert.doesNotMatch(getFaces(STUDIES[0].slug)[0], /data-ui/);

// The photographs corrupt too, on the same clock, by repainting blocks from
// the wrong place in the source. Tiles are sampled from that canvas, so the
// damage reaches the hover explosion and the dragon without either knowing.
assert.match(photo, /export function createPhotos/);
assert.match(photo, /import \{ RAMP_MS, onsetFrom \} from "\.\/aging\.js"/);
assert.match(motion, /image\.__photoSurface\?\.canvas \|\| image/);
assert.match(motion, /photos\.rebuild\(\)/);
assert.match(motion, /photos\.setElapsed\(state\.elapsed, \{ immediate, settle \}\)/);
assert.match(motion, /photos\.restore\(restoreKeys\)/);
assert.match(motion, /photos\.reset\(\)/);
// Regular image restore keys still name one corruption block. Compact marks
// additionally accept a whole-surface key so their source is erased and healed
// without exposing the underlying grid.
assert.match(photo, /export function photoGrid/);
assert.match(photo, /export function diffuseTileTarget/);
assert.match(motion, /diffuseTileTarget\(image\)/);
assert.match(photo, /context\.clearRect\(x, y, blockWidth/);
const defaultPhotoGrid = photoGrid(100, 100);
const compactLogoGrid = photoGrid(100, 100, 25);
assert.ok(
  compactLogoGrid.columns * compactLogoGrid.rows
    < defaultPhotoGrid.columns * defaultPhotoGrid.rows,
);
assert.equal(compactLogoGrid.columns * compactLogoGrid.rows, 25);
assert.equal(diffuseTileTarget({ dataset: { diffuseTiles: "25" } }), 25);
assert.equal(diffuseTileTarget({ dataset: {} }), IMAGE_TILE_TARGET);

// Fractional grid sizes still partition the backing canvas into exact physical
// pixel cells. Every neighbour shares one integer boundary, and the complete
// set covers the canvas once without gaps or overlap.
for (const [width, height, columns, rows] of [
  [473, 631, 14, 19],
  [357, 241, 17, 13],
  [24, 24, 5, 5],
]) {
  let coveredArea = 0;
  for (let row = 0; row < rows; row += 1) {
    let previousRight = 0;
    for (let column = 0; column < columns; column += 1) {
      const rect = photoBlockRect(width, height, columns, rows, column, row);
      assert.equal(Number.isInteger(rect.left), true);
      assert.equal(Number.isInteger(rect.top), true);
      assert.equal(Number.isInteger(rect.right), true);
      assert.equal(Number.isInteger(rect.bottom), true);
      assert.equal(rect.left, previousRight);
      if (!column) assert.equal(rect.left, 0);
      if (column === columns - 1) assert.equal(rect.right, width);
      if (!row) assert.equal(rect.top, 0);
      if (row === rows - 1) assert.equal(rect.bottom, height);
      if (row) {
        const above = photoBlockRect(width, height, columns, rows, column, row - 1);
        assert.equal(rect.top, above.bottom);
      }
      coveredArea += rect.width * rect.height;
      previousRight = rect.right;
    }
  }
  assert.equal(coveredArea, width * height);
}

const wholeLogo = {
  dataset: { diffuseTiles: "25" },
  hasAttribute: (name) => name === "data-diffuse-whole",
};
assert.deepEqual(imageCaptureGrid(wholeLogo, 24, 24), { columns: 1, rows: 1 });
assert.equal(wholeImageFragmentMix(0.08), 0);
assert.ok(wholeImageFragmentMix(0.18) > 0 && wholeImageFragmentMix(0.18) < 1);
assert.equal(wholeImageFragmentMix(0.28), 1);
assert.equal(handoffFragmentMix(0, 0), 0);
assert.equal(handoffFragmentMix(0.4, 0), 0.4);
assert.ok(handoffFragmentMix(0.4, 0.03) > 0.4);
assert.equal(handoffFragmentMix(0, 0.06), 1);
assert.deepEqual(
  imageCaptureGrid({ dataset: { diffuseTiles: "25" }, hasAttribute: () => false }, 24, 24),
  compactLogoGrid,
);
const logoRestoreKeys = new Set(["a:img3:whole"]);
assert.equal(restoresDiffuseBlock(logoRestoreKeys, "a:img3", "a:img3:0:0"), true);
assert.equal(restoresDiffuseBlock(logoRestoreKeys, "a:img4", "a:img4:0:0"), false);
assert.equal(
  restoresDiffuseBlock(new Set(["a:img3:2:4"]), "a:img3", "a:img3:2:4"),
  true,
);
const releasedCanvas = {
  removed: false,
  remove() {
    this.removed = true;
  },
};
const releasedImage = { dataset: { diffuseCanvasReady: "true" } };
const releasedSurface = { image: releasedImage, canvas: releasedCanvas };
releasedImage.__photoSurface = releasedSurface;
releaseDiffuseSurface(releasedSurface);
assert.equal(releasedCanvas.removed, true);
assert.equal(releasedImage.dataset.diffuseCanvasReady, undefined);
assert.equal(releasedImage.__photoSurface, undefined);
const currentCanvas = { removed: false, remove() { this.removed = true; } };
const staleCanvas = { removed: false, remove() { this.removed = true; } };
const replacementImage = { dataset: { diffuseCanvasReady: "true" } };
const currentSurface = { image: replacementImage, canvas: currentCanvas };
const staleSurface = { image: replacementImage, canvas: staleCanvas };
replacementImage.__photoSurface = currentSurface;
releaseDiffuseSurface(staleSurface);
assert.equal(staleCanvas.removed, true);
assert.equal(replacementImage.dataset.diffuseCanvasReady, "true");
assert.equal(replacementImage.__photoSurface, currentSurface);
const photoReset = section(photo, "    reset() {", "    destroy() {");
assert.match(photoReset, /paintCleanSurface\(surface\)/);
assert.doesNotMatch(photoReset, /paint\(surface, block\)/);
const photoRestore = section(photo, "    restore(keys) {", "    reset() {");
assert.match(photoRestore, /keys\.has\(`\$\{surface\.key\}:whole`\)/);
assert.match(photoRestore, /paintCleanSurface\(surface\)/);
assert.match(photo, /paintCleanSurface\(surface\);\s*for \(const block of blocks\)/);
const photoSetElapsed = section(
  photo,
  "    setElapsed(next, { immediate = false, settle = false } = {}) {",
  "    // Re-roll the geometry",
);
assert.match(photoSetElapsed, /if \(elapsed === 0\)/);
assert.match(photoSetElapsed, /if \(changed\) paintCleanSurface\(surface\)/);
assert.match(photoSetElapsed, /const limit = immediate[\s\S]*?: paintBudget/);
assert.doesNotMatch(photoSetElapsed, /paintBudget \* 2/);
assert.match(photoSetElapsed, /immediate \|\| settle[\s\S]*?\? paintItems\.length/);
assert.match(photoSetElapsed, /settled: scanned >= paintItems\.length/);
{
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousDpr = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  let drawCalls = 0;
  const context = {
    clearRect() {},
    drawImage() {
      drawCalls += 1;
    },
    save() {},
    beginPath() {},
    rect() {},
    clip() {},
    restore() {},
  };
  const canvas = {
    width: 0,
    height: 0,
    className: "",
    isConnected: false,
    setAttribute() {},
    getContext: () => context,
    remove() {
      this.isConnected = false;
    },
  };
  const image = {
    complete: true,
    naturalWidth: 160,
    naturalHeight: 120,
    dataset: { imageKey: "photo-test" },
    getBoundingClientRect: () => ({ width: 80, height: 60 }),
    parentElement: {
      appendChild(node) {
        node.isConnected = true;
      },
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "devicePixelRatio", {
    configurable: true,
    value: 3,
  });
  try {
    const photos = createPhotos({
      layers: [
        { querySelectorAll: () => [image] },
        { querySelectorAll: () => [] },
      ],
      tileTarget: 16,
      dprCap: 3,
      maxPaintsPerTick: 1,
      churnPerTick: 1,
    });
    photos.rebuild();
    assert.equal(canvas.width, 240);
    assert.equal(canvas.height, 180);
    const budgeted = photos.setElapsed(1_000_000);
    assert.equal(budgeted.painted, 1);
    assert.equal(budgeted.settled, false);
    let settled = false;
    for (let pass = 0; pass < 20 && !settled; pass += 1) {
      settled = photos.setElapsed(1_000_000, { settle: true }).settled;
    }
    assert.equal(settled, true, "photo settlement must converge in bounded passes");
    assert.ok(image.__photoSurface.blocks.every((block) => block.level > 0));
    const beforeZero = drawCalls;
    const rewound = photos.setElapsed(0);
    assert.equal(rewound.painted, image.__photoSurface.blocks.length);
    assert.equal(rewound.settled, true);
    assert.equal(
      drawCalls - beforeZero,
      1,
      "a full photo rewind must use one clean surface draw",
    );
    assert.ok(image.__photoSurface.blocks.every((block) => block.level === 0));
    photos.destroy();
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument);
    } else {
      delete globalThis.document;
    }
    if (previousDpr) {
      Object.defineProperty(globalThis, "devicePixelRatio", previousDpr);
    } else {
      delete globalThis.devicePixelRatio;
    }
  }
}
const photoBlockPaint = section(photo, "  function paint(surface, block) {", "  function levelFor(block) {");
assert.match(photoBlockPaint, /photoBlockRect\(/);
assert.match(photoBlockPaint, /context\.clearRect\(x, y, blockWidth, blockHeight\)/);
assert.match(
  photoBlockPaint,
  /context\.rect\(x, y, blockWidth, blockHeight\);\s*context\.clip\(\)/,
);
assert.match(
  photoBlockPaint,
  /context\.drawImage\(\s*image,\s*0,\s*0,\s*image\.naturalWidth,\s*image\.naturalHeight,\s*0,\s*0,\s*canvas\.width,\s*canvas\.height/,
);
assert.doesNotMatch(photoBlockPaint, /blockWidth \+ 0\.6|blockHeight \+ 0\.6|\+ 0\.4/);
assert.match(photo, /image\.dataset\.diffuseCanvasReady = "true"/);
assert.match(photo, /delete image\.dataset\.diffuseCanvasReady;\s*try \{/);
assert.match(photo, /for \(const surface of stale\) releaseDiffuseSurface\(surface\)/);
assert.match(photo, /releaseDiffuseSurface\(previous \|\| \{ image, canvas \}\)/);
assert.match(
  styles,
  /img\[data-diffuse\]\[data-diffuse-canvas-ready="true"\]\s*\{\s*opacity:\s*0/,
);
const posedLocalDraw = section(
  motion,
  "  if (POSED_FRAGMENT_MODES.has(mode)) {",
  "  switch (mode) {",
);
assert.match(posedLocalDraw, /glyph\.kind === "image" \? wholeImageFragmentMix\(amount\) : 1/);
assert.match(posedLocalDraw, /drawGlyph\(context, glyph, 1 - fragmentMix\)/);
assert.match(posedLocalDraw, /drawGlyphFragment\([\s\S]*?fragmentMix/);
assert.match(motion, /const TILED_IMAGE_OVERDRAW = 0\.5/);
assert.match(motion, /const overdraw = glyph\.wholeImage \? 0 : TILED_IMAGE_OVERDRAW/);
assert.match(motion, /imageGroupKey: baseKey/);
assert.deepEqual(
  imageGridBoundaries(10.2, 80, 4, 1.5),
  [10.2, 30, 50, 70, 90.2],
);
assert.match(
  motion,
  /imageGridBoundaries\(\s*box\.left,\s*box\.width,\s*columns,\s*captureDpr/,
);
const localPhotoMask = imageMaskGeometry({
  rect: { left: 20, top: 30, width: 16, height: 12 },
  imageGroupRect: { left: 10, top: 15, width: 80, height: 100 },
});
assert.deepEqual(localPhotoMask, {
  kind: "image-tile",
  left: 20,
  top: 30,
  right: 36,
  bottom: 42,
  width: 16,
  height: 12,
});
assert.match(motion, /function drawImageTileMask/);
assert.match(motion, /imageMaskGeometry\(glyph\),\s*imageFragmentMix\(effect\)/);
assert.match(motion, /rect\.kind === "image-tile"/);
assert.doesNotMatch(motion, /soft-image|drawSoftImageMask|softImageMaskStamp|createRadialGradient/);
assert.doesNotMatch(motion, /IMAGE_TILE_MASK_BLEED/);
assert.match(
  motion,
  /visibleLocalEffects\(\s*active,\s*performanceProfile\.localEffectHardLimit/,
);
assert.match(motion, /localDirtyRects = dirtyRectsForEffects\(visible\)/);
assert.doesNotMatch(motion, /drawActiveImageGroups|imageGroupEraseRect|drawImageGroupBase/);
assert.match(motion, /fragmentMix: fragmentMixFor\(effect\)/);
assert.match(motion, /handoffFragmentMix\(rect\.fragmentMix \?\? 1, progress\)/);
assert.match(
  motion,
  /handoffFragmentMix\(token\.handoff\.fragmentMix \?\? 1, poseProgress\)/,
);
// A page mounted at zero size must not floor the type or skip its surfaces.
assert.match(motion, /page\.clientWidth < 8 \|\| page\.clientHeight < 8/);
assert.match(motion, /new ResizeObserver/);
// Multi-column pages overflow sideways, so height alone never sees it.
assert.match(motion, /page\.scrollWidth > page\.clientWidth/);
assert.match(styles, /columns: 2/);

// The third photograph and its caption.
assert.ok(getFaces(STUDIES[0].slug)[1].includes("/lawrence-3.jpg"));
assert.ok(getFaces(STUDIES[0].slug)[1].includes("got swole in japan"));
assert.ok(getFaces(STUDIES[0].slug)[0].includes("pic taken by my talented gf in montreal"));

// Featured publications, and a CV that actually exists.
assert.ok(getFaces(STUDIES[0].slug)[0].includes("Featured publications"));
assert.ok(/see full list on/i.test(getFaces(STUDIES[0].slug)[0]));
assert.ok(getFaces(STUDIES[0].slug)[0].includes(
  "Xu, P.*; <b>Long, L.Y.</b>*; et al.; Faure, G.† &amp; Zhang, F.† (2026). “RNA-guided transcriptional repression by TIGR-Tas systems.”",
));
assert.ok(!getFaces(STUDIES[0].slug)[0].includes(
  "TIGR-Tas diversity reveals co-evolved architecture",
));
assert.ok(!getFaces(STUDIES[0].slug)[0].includes("Submitted to Nature Microbiology"));
assert.ok(getFaces(STUDIES[0].slug)[0].includes(
  "<i>In revision at Nature Microbiology</i>",
));
assert.ok(getFaces(STUDIES[0].slug)[0].includes(
  "White, F.M. (2026). “Uncovering the signaling networks",
));
assert.ok(!getFaces(STUDIES[0].slug)[0].includes(
  "White, F.M. (2024). “Uncovering the signaling networks",
));
assert.match(data, /aria-label="Google Scholar"/);
assert.match(data, /src="\/google-scholar\.svg"[^>]*data-diffuse-whole[^>]*data-diffuse-tiles="25"/);
const cvPath = resolve(root, "public", "cv.pdf");
await stat(cvPath);
assert.equal(
  createHash("sha256").update(await readFile(cvPath)).digest("hex"),
  "ca5e06137ad101b36f47bdda1dcfd539159d8bd23f0af199d81b20d9e2bb2b51",
  "the published CV must remain the reviewed phone-free replacement",
);

// The sprite budget is chosen per machine: declared capability first, then the
// frame cost actually observed during a transition. Both spend through the
// same stratified sampler, so a lite page is the same picture with fewer
// pieces rather than a cropped one.
assert.match(quality, /export const FULL_TOKEN_LIMIT = 10000/);
assert.match(quality, /export const LITE_TOKEN_LIMIT = 1600/);
assert.match(quality, /export const MOBILE_TOKEN_MULTIPLIER = 3/);
assert.match(quality, /export const MOBILE_MIN_TOKEN_LIMIT = 1440/);
assert.match(quality, /export const MOBILE_MAX_TOKEN_LIMIT = 2160/);
assert.match(quality, /export const MOBILE_PIXELS_PER_TOKEN = 560/);
assert.match(quality, /export const MOBILE_GLOBAL_DPR_CAP = 1/);
assert.match(quality, /export const MOBILE_LOCAL_DPR_CAP = 1/);
assert.match(quality, /nav\?\.deviceMemory/);
assert.match(quality, /nav\?\.hardwareConcurrency/);
assert.match(quality, /\(pointer: coarse\)/);
assert.match(motion, /quality\.tokenLimit/);
assert.match(motion, /quality\.sample\(now\)/);
assert.match(motion, /performanceProfile\.transitionFrameMs/);
assert.match(motion, /performanceProfile\.localFrameMs/);
assert.match(motion, /performanceProfile\.imageTileTarget/);
assert.match(motion, /performance:\s*performanceProfile\.aging/);
assert.match(quality, /cacheCleanBlocks:\s*true/);
// A demotion has to throw away everything built to the old budget.
const animateBody = section(motion, "function animateProgress", "function refreshPendingCapture");
assert.match(animateBody, /quality\.sample\(now\)[\s\S]{0,400}invalidateScenes\(\)/);
{
  const {
    createQuality,
    detectQualityTier,
    mobileTokenLimit,
  } = await import("../src/quality.js");
  // Whatever the host reports, the budget must always match the tier. Node
  // exposes navigator.hardwareConcurrency, so the detected tier varies by
  // machine and must never be asserted directly.
  const detected = createQuality();
  assert.ok(["mobile", "lite", "full"].includes(detected.tier));
  assert.ok(detected.tokenLimit >= 1440 && detected.tokenLimit <= 10000);

  const full = createQuality({ initialTier: "full" });
  assert.equal(full.tokenLimit, 10000);
  assert.equal(full.globalDprCap, 1.3);
  assert.equal(full.localDprCap, 1.55);
  assert.equal(full.performanceProfile.transitionFrameMs, 0);
  assert.equal(full.performanceProfile.pointerSamples, 20);
  assert.equal(full.performanceProfile.rotatingTokenStride, 1);
  assert.equal(full.performanceProfile.passiveMidpointMotion, true);
  assert.equal(full.performanceProfile.localEffectHardLimit, 40);
  assert.equal(full.performanceProfile.midpointEffectHardLimit, 160);
  assert.equal(full.performanceProfile.imageTileTarget, 260);
  assert.deepEqual(full.performanceProfile.photo, {
    dprCap: 2,
    maxPaintsPerTick: 26,
    churnPerTick: 10,
    cacheCleanBlocks: false,
  });
  assert.deepEqual(full.performanceProfile.aging, {
    tickMs: 380,
    maxWritesPerTick: 90,
    noiseTickMs: 110,
    noisePerTick: 30,
    liveLimit: 96,
    liveRotateMs: 700,
  });

  // Phones and tablets get a budget proportional to their visible area. The
  // touch and coarse-pointer requirements keep narrow desktop windows and
  // touch-capable laptops on the full presentation.
  const iphoneSignals = {
    memory: undefined,
    cores: 6,
    touchPoints: 5,
    coarse: true,
    width: 390,
    height: 844,
  };
  const iphone = createQuality({ signals: iphoneSignals });
  assert.equal(detectQualityTier(iphoneSignals), "mobile");
  assert.equal(iphone.tier, "mobile");
  assert.equal(iphone.tokenLimit, 1764);
  assert.equal(iphone.globalDprCap, 1);
  assert.equal(iphone.localDprCap, 1);
  assert.equal(iphone.performanceProfile.transitionFrameMs, 32);
  assert.equal(iphone.performanceProfile.pointerSamples, 6);
  assert.equal(iphone.performanceProfile.rotatingTokenStride, 4);
  assert.equal(iphone.performanceProfile.passiveMidpointMotion, false);
  assert.equal(iphone.performanceProfile.localEffectHardLimit, 18);
  assert.equal(iphone.performanceProfile.midpointEffectHardLimit, 72);
  assert.equal(iphone.performanceProfile.imageTileTarget, 96);
  assert.deepEqual(iphone.performanceProfile.photo, {
    dprCap: 3,
    maxPaintsPerTick: 8,
    churnPerTick: 3,
    cacheCleanBlocks: true,
  });
  assert.deepEqual(iphone.performanceProfile.aging, {
    tickMs: 520,
    maxWritesPerTick: 36,
    noiseTickMs: 180,
    noisePerTick: 10,
    liveLimit: 28,
    liveRotateMs: 1000,
  });

  const androidSignals = {
    memory: 8,
    cores: 8,
    touchPoints: 5,
    coarse: true,
    width: 412,
    height: 915,
  };
  assert.equal(detectQualityTier(androidSignals), "mobile");
  assert.equal(createQuality({ signals: androidSignals }).tokenLimit, 2019);

  const ipadSignals = {
    memory: undefined,
    cores: 8,
    touchPoints: 5,
    coarse: true,
    width: 768,
    height: 1024,
  };
  assert.equal(detectQualityTier(ipadSignals), "mobile");
  assert.equal(createQuality({ signals: ipadSignals }).tokenLimit, 2160);
  assert.equal(mobileTokenLimit(360, 640), 1440);
  assert.equal(mobileTokenLimit(390, 844), 1764);
  assert.equal(mobileTokenLimit(768, 1024), 2160);

  const desktopSignals = {
    memory: 8,
    cores: 8,
    touchPoints: 0,
    coarse: false,
    width: 1440,
    height: 900,
  };
  const desktop = createQuality({ signals: desktopSignals });
  assert.equal(desktop.tier, "full");
  assert.equal(desktop.tokenLimit, 10000);
  assert.equal(desktop.globalDprCap, 1.3);
  assert.equal(desktop.localDprCap, 1.55);

  const touchLaptopSignals = {
    ...desktopSignals,
    touchPoints: 10,
    width: 1366,
    height: 768,
  };
  assert.equal(detectQualityTier(touchLaptopSignals), "full");
  assert.equal(detectQualityTier({
    ...desktopSignals,
    coarse: true,
    width: 390,
    height: 844,
  }), "full", "a coarse pointer without touch points is not a mobile device");

  // Existing capability-based lite selection remains available to constrained
  // non-mobile machines, and retains its established 1,600-token budget.
  const lite = createQuality({
    signals: { ...desktopSignals, memory: 4 },
  });
  assert.equal(lite.tier, "lite");
  assert.equal(lite.tokenLimit, 1600);
  assert.equal(lite.globalDprCap, 1.3);
  assert.equal(lite.localDprCap, 1.55);

  // Sustained slow frames demote it, and the budget follows the tier.
  let demoted = false;
  for (let frame = 0, now = 0; frame < 200 && !demoted; frame += 1) {
    now += 90;
    demoted = full.sample(now);
  }
  assert.ok(demoted, "sustained slow frames must drop the tier");
  assert.equal(full.tier, "lite");
  assert.equal(full.tokenLimit, 1600);

  // Frames comfortably inside budget must never demote.
  const healthy = createQuality({ initialTier: "full" });
  let dropped = false;
  for (let frame = 0, now = 0; frame < 400 && !dropped; frame += 1) {
    now += 16;
    dropped = healthy.sample(now);
  }
  assert.equal(dropped, false, "fast frames must not demote");
  assert.equal(healthy.tier, "full");
}

// Two instructions, swapped in CSS by phase so the block stays out of the
// corruption system's way.
assert.match(main, /page-motto-stable/);
assert.match(main, /page-motto-midpoint/);
assert.ok(main.includes(
  "The page ages and its text corrupts naturally (or turn the clock hand to speed up aging). Reverse the age by perturbing the text. Above a certain perturbation threshold (or if you press space), you will be able to reprogram the page to an entirely different state!",
));
assert.ok(main.includes(
  "Congrats, you've reprogrammed the page! Perturb the dragon to reveal the next state.",
));
assert.ok(/aging is information corruption/.test(main));
assert.match(styles, /\[data-phase="midpoint"\] \.page-motto-midpoint/);

// Icon and preview copy. There is one authoritative browser-tab candidate;
// the 512px source asset and Apple touch icon remain packaged and static.
assert.match(indexHtml, /<link id="site-favicon" rel="icon" href="\/favicon-32\.png"/);
assert.match(indexHtml, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
assert.equal((indexHtml.match(/rel="icon"/g) || []).length, 1);
assert.equal((indexHtml.match(/googletagmanager\.com\/gtag\/js\?id=G-0NMHZQWQ0S/g) || []).length, 1);
assert.match(indexHtml, /gtag\("config", "G-0NMHZQWQ0S"\)/);
assert.equal((indexHtml.match(/static\.cloudflareinsights\.com\/beacon\.min\.js/g) || []).length, 1);
assert.match(
  indexHtml,
  /data-cf-beacon='\{"token": "10d3369ee75f454590285f5a058a97ec"\}'/,
);
for (const icon of ["favicon-32.png", "icon-512.png", "apple-touch-icon.png"]) {
  await stat(resolve(root, "public", icon));
  assert.equal((await worker.fetch(new Request(`https://example.test/${icon}`))).status, 200);
}
const faviconModuleResponse = await worker.fetch(new Request("https://example.test/favicon.js"));
assert.equal(faviconModuleResponse.status, 200);
assert.equal(faviconModuleResponse.headers.get("content-type"), "text/javascript; charset=utf-8");

// The favicon plan is deterministic and derives solely from displayed page
// age, so a rewind traverses the same slice geometry in reverse. Its returning
// flag only adds the faint afterimage that makes reconstruction readable.
assert.equal(faviconDamage(0), 0);
assert.ok(faviconDamage(22000) > 0.25);
assert.ok(faviconDamage(90000) < 1);
assert.ok(faviconDamage(90000) > faviconDamage(45000));
const youngFavicon = faviconFrame(12000);
const oldFavicon = faviconFrame(90000);
assert.deepEqual(oldFavicon, faviconFrame(90000));
assert.ok(oldFavicon.damage > youngFavicon.damage);
assert.ok(oldFavicon.slices.length > youngFavicon.slices.length);
assert.ok(oldFavicon.shards.length > youngFavicon.shards.length);
const rewindDamage = [90000, 45000, 0].map((elapsed) => faviconFrame(elapsed).damage);
assert.ok(rewindDamage[0] > rewindDamage[1] && rewindDamage[1] > rewindDamage[2]);
for (const frame of [youngFavicon, oldFavicon, faviconFrame(45000, { recovering: true })]) {
  for (const slice of frame.slices) {
    assert.ok(Number.isInteger(slice.y) && Number.isInteger(slice.height));
    assert.ok(Number.isInteger(slice.shift));
    assert.ok(slice.y >= 0 && slice.y + slice.height <= 32);
  }
}
assert.deepEqual(
  faviconFrame(45000, { recovering: true }).slices,
  faviconFrame(45000).slices,
);

// A small fake canvas exercises the controller without a browser or timing
// sleeps: old -> younger -> newborn must replace, then restore, the same static
// link, and teardown must leave the fallback intact.
{
  const attributes = new Map([["href", "/favicon-32.png"]]);
  const link = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  let dataUrlSerial = 0;
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let index = 0; index < 32 * 32; index += 1) {
    const offset = index * 4;
    const isInk = index % 11 === 0;
    pixels[offset] = isInk ? 245 : 7;
    pixels[offset + 1] = isInk ? 245 : 7;
    pixels[offset + 2] = isInk ? 243 : 7;
    pixels[offset + 3] = 255;
  }
  const context = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    clip() {},
    clearRect() {},
    drawImage() {},
    fillRect() {},
    getImageData: () => ({ data: pixels }),
  };
  const makeCanvas = () => ({
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: () => `data:image/png;base64,frame-${dataUrlSerial += 1}`,
  });
  const image = {
    complete: true,
    naturalWidth: 32,
    addEventListener() {},
    removeEventListener() {},
    decode: () => Promise.resolve(),
  };
  let canvasCount = 0;
  let wallTime = 1000;
  const documentRef = {
    querySelector: () => link,
    createElement(tagName) {
      if (tagName === "img") return image;
      canvasCount += 1;
      return makeCanvas();
    },
  };
  const controller = createAgingFavicon({ documentRef, now: () => wallTime });
  await Promise.resolve();
  controller.setElapsed(90000);
  const oldHref = attributes.get("href");
  assert.match(oldHref, /^data:image\/png;base64,/);
  controller.setElapsed(45000);
  assert.notEqual(attributes.get("href"), oldHref);
  controller.setElapsed(0);
  assert.equal(attributes.get("href"), "/favicon-32.png");
  controller.setElapsed(90000);
  const preRewindHref = attributes.get("href");
  wallTime += 1;
  controller.setElapsed(89999.5, { recovering: true });
  assert.equal(
    attributes.get("href"),
    preRewindHref,
    "compressed rewind frames must be throttled by wall time",
  );
  wallTime += 160;
  controller.setElapsed(70000, { recovering: true });
  assert.notEqual(attributes.get("href"), preRewindHref);
  controller.setElapsed(0, { recovering: true });
  assert.equal(attributes.get("href"), "/favicon-32.png");
  controller.setElapsed(90000);
  controller.destroy();
  controller.destroy();
  assert.equal(attributes.get("href"), "/favicon-32.png");
  assert.equal(canvasCount, 2);
}
assert.match(favicon, /function clipToTile/);
assert.match(favicon, /frame\.recovering/);
assert.match(favicon, /link\.setAttribute\("href", url\)/);
assert.match(motion, /import \{ createAgingFavicon \} from "\.\/favicon\.js"/);
assert.match(motion, /const favicon = createAgingFavicon\(\)/);
assert.match(motion, /favicon\.destroy\(\)/);

const ageReadout = section(motion, "  function updateAgeReadout() {", "  // Corruption is drawn entirely");
assert.match(ageReadout, /if \(!ageState \|\| rewindingAge\) return/);
assert.match(ageReadout, /favicon\.setElapsed\(ageState\.elapsed\)/);
const resetCell = section(motion, "  function resetCellState() {", "  function onAdvance()");
assert.match(resetCell, /rewindingAge = true;\s*syncClockControl\(\);\s*aging\.reset\(\)/);
assert.match(resetCell, /const remaining = 1 - smoother\(progress\)/);
assert.match(resetCell, /from\.turns \* 360 \* remaining/);
assert.match(resetCell, /favicon\.setElapsed\(elapsed, \{ recovering: true \}\)/);
assert.match(resetCell, /writeAgeLine\(from\.seconds \* remaining\)/);
assert.match(resetCell, /if \(reducedMotion\.matches\)[\s\S]*?rewindingAge = false/);
assert.match(enterBody, /if \(reducedMotion\.matches\) \{\s*resetCellState\(\)/);
const motionPreference = section(
  motion,
  "  function onMotionPreference() {",
  "  const onPointerLeave",
);
assert.match(
  motionPreference,
  /if \(countdownFrame\) cancelAnimationFrame\(countdownFrame\);[\s\S]*?rewindingAge = false/,
);
assert.match(styles, /\.age-clock\[data-rewind="true"\] \.age-clock-hand \{[\s\S]*?transition: none/);
assert.equal((indexHtml.match(/Lawrence's personal website/g) || []).length, 3);

// Contact details, and no leftover placeholders.
const [contactFace, secondContactFace] = getFaces(STUDIES[0].slug);
const publicationsSource = section(data, "const publications = `", "const contacts = `");
const contactsSource = section(data, "const contacts = `", "const currentYear");
assert.match(publicationsSource, /scholar\.google\.com\/citations\?user=AkYzW8IAAAAJ/);
assert.doesNotMatch(contactsSource, /scholar\.google\.com|Google Scholar|google-scholar\.svg/);
assert.equal((contactFace.match(/scholar\.google\.com/g) || []).length, 1);
assert.equal((secondContactFace.match(/scholar\.google\.com/g) || []).length, 0);
assert.doesNotMatch(data, />\s*(?:Google Scholar|GitHub|LinkedIn)\s*<\/a>/);
assert.match(contactsSource, /aria-label="GitHub"/);
assert.match(contactsSource, /aria-label="LinkedIn"/);
assert.match(contactsSource, /src="\/github\.svg"[^>]*data-diffuse-whole[^>]*data-diffuse-tiles="25"/);
assert.match(contactsSource, /src="\/linkedin\.svg"[^>]*data-diffuse-whole[^>]*data-diffuse-tiles="25"/);
assert.doesNotMatch(contactsSource, /mailto:|belong@mit\.edu/);
for (const face of [contactFace, secondContactFace]) {
  const visibleText = face.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  assert.ok(visibleText.includes("email: belong at mit dot edu"));
  assert.ok(face.includes('class="contact-email"'));
  assert.ok(!face.includes("mailto:belong@mit.edu"));
  assert.ok(face.includes("https://github.com/oohs"));
  assert.ok(face.includes("https://www.linkedin.com/in/lawrenceylong"));
  assert.equal((face.match(/src="\/github\.svg"/g) || []).length, 1);
  assert.equal((face.match(/src="\/linkedin\.svg"/g) || []).length, 1);
  assert.ok(!/coming soon|linked TBD/.test(face), "no placeholder contact links remain");
}

// The shared footer stays in the semantic page so its copy, year, and both
// compactly tiled brand marks age, clean, and disperse with everything else.
assert.match(data, /new Date\(\)\.getFullYear\(\)/);
for (const face of getFaces(STUDIES[0].slug)) {
  assert.ok(face.includes('class="page-footer"'));
  assert.ok(face.includes("made with imagination"));
  const year = new Date().getFullYear();
  assert.ok(face.includes(`© <time datetime="${year}">${year}</time> Lawrence Long`));
  assert.equal((face.match(/class="footer-logo"/g) || []).length, 2);
  assert.ok(!face.includes("data-ui"));
}
const footerSource = section(data, "const pageFooter = `", "const selectedWork = `");
assert.equal((footerSource.match(/data-diffuse-tiles="25"/g) || []).length, 2);
assert.equal((footerSource.match(/data-diffuse-whole/g) || []).length, 2);
for (const logo of ["codex-logo.png", "claude-logo.png"]) {
  await stat(resolve(root, "public", logo));
  const response = await worker.fetch(new Request(`https://example.test/${logo}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
}
for (const icon of ["google-scholar.svg", "github.svg", "linkedin.svg"]) {
  const sourceIcon = await stat(resolve(root, "public", icon));
  const builtIcon = await stat(resolve(root, "dist", icon));
  assert.equal(builtIcon.size, sourceIcon.size);
  const response = await worker.fetch(new Request(`https://example.test/${icon}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.equal((await response.arrayBuffer()).byteLength, sourceIcon.size);
}
const linkedinIcon = await readFile(resolve(root, "public", "linkedin.svg"), "utf8");
assert.match(linkedinIcon, /<title>LinkedIn<\/title>/);
assert.doesNotMatch(
  linkedinIcon,
  /M0 1\.146C0 \.513\.526 0 1\.175 0h13\.65/,
  "LinkedIn should remain a transparent standalone glyph, not a square-backed mark",
);

// Copy corrections.
assert.ok(contactFace.includes("active chromatin across mitosis"));
assert.ok(contactFace.includes("agentic biological discovery"));
assert.ok(contactFace.includes("signaling networks in glioblastoma"));
assert.ok(contactFace.includes("cell type abundance deconvolution from proteomics"));
for (const gone of ["MIT Economics", "INSIGHT analysis", "inverse biological"]) {
  assert.ok(!contactFace.includes(gone), `"${gone}" should be gone`);
}
assert.ok(getFaces(STUDIES[0].slug)[1].includes("sweaty vibe-coder"));
assert.ok(getFaces(STUDIES[0].slug)[1].includes("go MIT Table Tennis club"));

// Leaving the attractor is twice the work it was.
assert.equal(STUDIES[0].midpointRequired, 3000);

// The tab title rots with the page.
assert.match(motion, /function corruptTitle/);
assert.match(motion, /document\.title = out/);
assert.match(aging, /export function titleNoise/);
assert.match(aging, /corrupted: records\.size/);

// Touch normally owns the interaction. Only very small landscape phones opt
// into vertical page scrolling so long content remains legible instead of
// overflowing into an invisible third column.
assert.match(styles, /touch-action: none/);
assert.match(styles, /@media \(max-width: 599px\) and \(max-height: 380px\) and \(orientation: landscape\)/);
assert.match(styles, /touch-action: pan-y/);
assert.match(styles, /overflow-y: auto/);
assert.match(motion, /addEventListener\("pointerdown", onPointerDown/);
assert.match(motion, /addEventListener\("pointercancel", onPointerLeave/);
assert.match(
  motion,
  /!clockDragging\s*&& !clockReconciling[\s\S]*?\) photos\.churn\(\)/,
);
for (const [event, handler] of [
  ["pointerdown", "onClockPointerDown"],
  ["pointermove", "onClockPointerMove"],
  ["pointerup", "onClockPointerEnd"],
  ["pointercancel", "onClockPointerCancel"],
  ["lostpointercapture", "onClockLostPointerCapture"],
  ["keydown", "onClockKeyDown"],
]) {
  assert.match(motion, new RegExp(`clockControl\\?\\.addEventListener\\("${event}", ${handler}\\)`));
  assert.match(motion, new RegExp(`clockControl\\?\\.removeEventListener\\("${event}", ${handler}\\)`));
}

// Content moves that were asked for.
const [pageOne, pageTwo] = getFaces(STUDIES[0].slug);
assert.ok(pageOne.includes("Selected research"), "selected research belongs on page 1");
assert.ok(!pageTwo.includes("Selected research"));
assert.ok(pageTwo.includes("Outside the lab"), "outside the lab belongs on page 2");
assert.ok(!pageOne.includes("Outside the lab"));
assert.ok(pageTwo.includes("Interesting courses taken"), "coursework belongs on page 2");
assert.ok(!pageOne.includes("Interesting courses taken"));
assert.ok(pageTwo.includes("Italicized courses are my favorites."));
assert.ok(!pageOne.includes("Italicized courses are my favorites."));
assert.ok(
  pageTwo.indexOf("Outside the lab") < pageTwo.indexOf("Interesting courses taken")
    && pageTwo.indexOf("Interesting courses taken") < pageTwo.indexOf("Contact"),
  "coursework should sit between Outside the lab and Contact",
);
const courseworkSource = section(data, "const interestingCourses = `", "const workFace = `");
const visibleCoursework = courseworkSource.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
assert.equal((courseworkSource.match(/class="course-list"/g) || []).length, 2);
assert.equal((courseworkSource.match(/<dt>/g) || []).length, 16);
assert.equal((courseworkSource.match(/<dd>/g) || []).length, 16);
assert.equal((courseworkSource.match(/<em>/g) || []).length, 10);
for (const [code, title] of [
  ["6.7960", "Deep Learning"],
  ["6.7920", "Reinforcement Learning"],
  ["8.323", "Relativistic Quantum Field Theory"],
  ["9.123", "Neurotechnology in Action"],
  ["18.436", "Quantum Information Science"],
  ["20.363", "Biomaterials Science and Engineering"],
  ["5.04", "Principles of Inorganic Chemistry II"],
  ["5.13", "Organic Chemistry II"],
  ["6.1220", "Design and Analysis of Algorithms"],
  ["8.044", "Statistical Physics I"],
  ["8.05", "Quantum Physics II"],
  ["8.225", "Physics in the 20th Century"],
  ["8.251", "String Theory for Undergraduates"],
  ["14.12", "Economic Applications of Game Theory"],
  ["14.39", "Large-Scale Decision-Making and Inference"],
  ["20.309", "Biological Instrumentation and Measurement"],
]) {
  assert.ok(visibleCoursework.includes(`${code} ${title}`), `${code} should keep its title`);
}
for (const favorite of [
  "Neurotechnology in Action",
  "Quantum Information Science",
  "Physics in the 20th Century",
  "String Theory for Undergraduates",
  "Biological Instrumentation and Measurement",
]) {
  assert.ok(courseworkSource.includes(`<dd><em>${favorite}</em></dd>`));
}
assert.match(
  styles,
  /\.default-page \.course-list \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 4\.25em minmax\(0, 1fr\)/,
);
assert.match(
  styles,
  /\.course-list dt \{[\s\S]*?font-variant-numeric: tabular-nums;[\s\S]*?text-align: right;/,
);
assert.match(
  styles,
  /@media \(min-width: 620px\) and \(max-width: 999px\) \{[\s\S]*?\.coursework-groups \{[\s\S]*?display: grid;/,
);
assert.ok(pageOne.includes("Graduated from MIT in 2026"));
assert.ok(pageTwo.includes("gym"));
assert.ok(pageOne.includes("/cv.pdf") && pageTwo.includes("/cv.pdf"));
assert.ok(pageOne.includes("Hi, I’m Lawrence Long, currently <em>"));
assert.ok(pageOne.includes("I like thinking about hard problems from a myriad of perspectives"));
assert.ok(pageOne.includes("understand “why do we age?”"));
assert.ok(!pageOne.includes("How I think"));
const expectedContact = "I’m always happy to connect with people! Especially if you are good at ping pong and in the Boston area, hmu! ;)";
assert.ok(pageOne.includes(expectedContact) && pageTwo.includes(expectedContact));
assert.match(main, /aging is information corruption\./);
assert.match(
  main,
  /The page ages and its text corrupts naturally \(or turn the clock hand to speed up aging\)\./,
);
assert.match(main, /Congrats, you've reprogrammed the page!/);
assert.match(main, /aria-describedby="page-instruction"/);
assert.match(main, /class="page-motto-instruction page-motto-stable" id="page-instruction"/);
for (const gone of [
  "This is a personal page",
  "Tools I reach for",
  "Current questions",
  "I’m fond of systems",
]) {
  assert.ok(!pageOne.includes(gone) && !pageTwo.includes(gone), `"${gone}" should be gone`);
}

// E19 — one colour event, applied as a lighten composite.
assert.match(motion, /globalCompositeOperation = "lighten"/);
assert.match(motion, /const FLASH_DECAY_MS = 430/);

// B6 — the swim seeks the pointer from the formation's own centre.
assert.match(motion, /function advanceSwim/);
assert.match(motion, /advanceSwim\(activeScene, midpointPointer, activeScene\.swimOrigin/);

// E22 — sound is opt-in and remembers the choice.
assert.match(audio, /localStorage\.getItem\(STORAGE_KEY\) === "on"/);
assert.match(main, /class="sound-control" aria-pressed="false"/);
assert.match(audio, /async function unlock/);
assert.match(audio, /const ready = enabled && audio\.state === "running"/);
assert.match(audio, /pendingFeedback \|\|= playFeedback/);
assert.match(audio, /primerBuffer = context\.createBuffer\(1, 1, context\.sampleRate\)/);
assert.match(audio, /brush\(now = wallTime\(\), intensity = 0\.5\)/);
assert.match(audio, /rustle\(now = wallTime\(\), amount = 0\.5\)/);
assert.doesNotMatch(
  section(audio, "  function live() {", "  function noiseBurst"),
  /ensureContext\(/,
);
assert.match(motion, /audio\.brush\(/);
assert.match(motion, /audio\.rustle\(/);
const soundButtonHandler = section(motion, "  async function onSoundButton() {", "  function unlockRememberedAudio()");
assert.match(soundButtonHandler, /audio\.setEnabled\(true\)/);
assert.match(soundButtonHandler, /audio\.unlock\(\{ feedback: true \}\)/);
assert.match(motion, /const active = status\.ready \|\| status\.activating/);
assert.match(soundButtonHandler, /const activation = audio\.unlock\(\{ feedback: true \}\);\s*syncSoundButton\(\);\s*await activation/);
assert.match(
  section(motion, "  function unlockRememberedAudio() {", "  function onPointerDown(event) {"),
  /const activation = audio\.unlock\(\);\s*syncSoundButton\(\);\s*void activation\.then\(syncSoundButton\)/,
);
assert.match(motion, /root\.addEventListener\("keydown", unlockRememberedAudio\)/);
assert.match(styles, /\.sound-control\[data-state="locked"\]/);
assert.match(styles, /@media \(min-width: 520px\) and \(max-width: 900px\) and \(max-height: 700px\) and \(orientation: landscape\)/);

// Sound activation is behavioral, not just a source contract. A silent primer
// and resume begin in the trusted gesture; exactly one audible paper preview
// follows as soon as the context is running, with no transition required.
{
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map([["loong:sound", "off"]]);
  const events = {
    contexts: 0,
    resumeCalls: 0,
    bufferStarts: 0,
    primerStarts: 0,
    oscillatorStarts: 0,
    closeCalls: 0,
    contextsList: [],
    gains: [],
    gainNodes: [],
    bufferSources: [],
    filters: [],
    pendingResumes: [],
    rejectNextResume: false,
  };

  class FakeParam {
    constructor(value = 0) {
      this.value = value;
      this.targets = [];
    }

    cancelScheduledValues() {}

    setTargetAtTime(value) {
      this.value = value;
      this.targets.push(value);
    }

    setValueAtTime(value) {
      this.value = value;
    }

    exponentialRampToValueAtTime(value) {
      this.value = value;
    }
  }

  class FakeNode {
    constructor(name = "node") {
      this.name = name;
      this.connections = [];
    }

    connect(target) {
      this.connections.push(target);
      return target;
    }
  }

  class FakeAudioContext {
    constructor() {
      events.contexts += 1;
      this.state = "suspended";
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = new FakeNode("destination");
      events.contextsList.push(this);
    }

    createBuffer(_channels, frames) {
      const data = new Float32Array(frames);
      return { frames, getChannelData: () => data };
    }

    createGain() {
      const node = new FakeNode("gain");
      node.gain = new FakeParam();
      events.gains.push(node.gain);
      events.gainNodes.push(node);
      return node;
    }

    createBiquadFilter() {
      const node = new FakeNode("filter");
      node.frequency = new FakeParam();
      node.Q = new FakeParam();
      events.filters.push(node);
      return node;
    }

    createBufferSource() {
      const node = new FakeNode("buffer-source");
      node.playbackRate = new FakeParam(1);
      node.start = () => {
        if (node.buffer?.frames === 1) events.primerStarts += 1;
        else events.bufferStarts += 1;
      };
      node.stop = () => {};
      events.bufferSources.push(node);
      return node;
    }

    createOscillator() {
      const node = new FakeNode("oscillator");
      node.type = "sine";
      node.frequency = new FakeParam();
      node.detune = new FakeParam();
      node.start = () => {
        events.oscillatorStarts += 1;
      };
      node.stop = () => {};
      return node;
    }

    resume() {
      events.resumeCalls += 1;
      if (events.rejectNextResume) {
        events.rejectNextResume = false;
        return Promise.reject(new Error("blocked"));
      }
      return new Promise((resolveResume) => {
        events.pendingResumes.push(() => {
          this.state = "running";
          resolveResume();
        });
      });
    }

    close() {
      events.closeCalls += 1;
      this.state = "closed";
      return Promise.resolve();
    }
  }

  try {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
    });

    const sound = createAudio();
    assert.equal(events.contexts, 0);
    assert.equal(sound.brush(1000, 1), false);
    assert.equal(sound.rustle(1000, 1), false);

    assert.equal(sound.setEnabled(true), true);
    assert.equal(stored.get("loong:sound"), "on");
    assert.equal(events.contexts, 1);
    assert.equal(events.resumeCalls, 0, "the button owns the one explicit unlock");
    assert.equal(events.gainNodes[0].connections[0], events.contextsList[0].destination);

    const unlocking = sound.unlock({ feedback: true });
    const sharedUnlock = sound.unlock({ feedback: true });
    const bubbledUnlock = sound.unlock();
    assert.equal(events.resumeCalls, 1, "resume begins synchronously in the gesture");
    assert.equal(events.primerStarts, 1, "a silent primer starts in the trusted gesture");
    assert.equal(events.bufferStarts, 0, "audible feedback waits for a running context");
    events.pendingResumes.shift()();
    assert.equal(await unlocking, true);
    assert.equal(await sharedUnlock, true);
    assert.equal(await bubbledUnlock, true);
    assert.equal(sound.ready, true);
    assert.equal(events.bufferStarts, 1, "concurrent unlocks coalesce to one preview");
    assert.ok(events.gains[0].targets.at(-1) > 0.1, "the master output is audible");
    const audibleSource = events.bufferSources.find((source) => source.buffer?.frames > 1);
    const audibleFilter = audibleSource.connections[0];
    const audibleEnvelope = audibleFilter.connections[0];
    assert.equal(audibleEnvelope.connections[0], events.gainNodes[0]);

    const brushStarts = events.bufferStarts;
    assert.equal(sound.brush(1000, 1), true);
    assert.equal(events.bufferStarts, brushStarts + 1);
    sound.arrival();
    assert.equal(events.oscillatorStarts, 3);
    sound.restore();
    assert.equal(events.oscillatorStarts, 5);

    assert.equal(sound.setEnabled(false), false);
    assert.equal(stored.get("loong:sound"), "off");
    assert.deepEqual(sound.status, {
      enabled: false,
      ready: false,
      activating: false,
      state: "off",
      error: "",
    });
    assert.equal(events.gains[0].targets.at(-1), 0.0001);
    const silentBufferStarts = events.bufferStarts;
    const silentOscillatorStarts = events.oscillatorStarts;
    assert.equal(sound.brush(2000, 1), false);
    assert.equal(sound.rustle(2000, 1), false);
    assert.equal(sound.tick(2000), false);
    sound.arrival();
    sound.restore();
    assert.equal(events.bufferStarts, silentBufferStarts);
    assert.equal(events.oscillatorStarts, silentOscillatorStarts);

    assert.equal(sound.setEnabled(true), true);
    assert.equal(events.contexts, 1, "re-enabling reuses the running context");
    assert.equal(await sound.unlock({ feedback: true }), true);
    assert.equal(events.resumeCalls, 1);
    assert.equal(events.bufferStarts, silentBufferStarts + 1);
    sound.destroy();
    assert.equal(events.closeCalls, 1);

    // Switching off while resume is pending invalidates that attempt. Its
    // silent primer may settle later, but no audible preview can leak.
    const canceled = createAudio();
    assert.equal(canceled.setEnabled(true), true);
    const canceledUnlock = canceled.unlock({ feedback: true });
    assert.equal(events.resumeCalls, 2);
    assert.equal(events.primerStarts, 2);
    const audibleBeforeCancel = events.bufferStarts;
    assert.equal(canceled.setEnabled(false), false);
    events.pendingResumes.shift()();
    assert.equal(await canceledUnlock, false);
    assert.equal(events.bufferStarts, audibleBeforeCancel);
    assert.equal(canceled.status.activating, false);
    canceled.destroy();
    assert.equal(events.closeCalls, 2);

    // A rejected resume leaves only a silent primer behind. Retrying on the
    // next trusted gesture produces one preview, not a stack of old previews.
    const retried = createAudio();
    assert.equal(retried.setEnabled(true), true);
    events.rejectNextResume = true;
    const audibleBeforeReject = events.bufferStarts;
    assert.equal(await retried.unlock({ feedback: true }), false);
    assert.equal(events.bufferStarts, audibleBeforeReject);
    const retryUnlock = retried.unlock({ feedback: true });
    events.pendingResumes.shift()();
    assert.equal(await retryUnlock, true);
    assert.equal(events.bufferStarts, audibleBeforeReject + 1);
    retried.destroy();
    assert.equal(events.closeCalls, 3);
  } finally {
    if (originalAudioContext) {
      Object.defineProperty(globalThis, "AudioContext", originalAudioContext);
    } else {
      delete globalThis.AudioContext;
    }
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
}

// The global animation must remain bounded even when every glyph keeps its
// detailed 3 × 3 local decomposition.
const transitionFixture = Array.from({ length: 22032 }, (_, index) => ({
  sourceId: `fixture:${index}`,
  pieceIndex: index % 9,
  imageTile: index % 5 === 0,
  ordinal: index,
}));
const cappedTransition = limitTransitionFragments(transitionFixture);
assert.equal(GLOBAL_TRANSITION_TOKEN_LIMIT, 10000);
assert.equal(cappedTransition.length, GLOBAL_TRANSITION_TOKEN_LIMIT);
assert.deepEqual(cappedTransition, limitTransitionFragments(transitionFixture));
assert.match(motion, /root\.dataset\.transitionTokens = String\(scene\.baseTokenCount\)/);
for (const imageTile of [false, true]) {
  for (let pieceIndex = 0; pieceIndex < 9; pieceIndex += 1) {
    assert.ok(
      cappedTransition.some((fragment) => (
        fragment.imageTile === imageTile && fragment.pieceIndex === pieceIndex
      )),
      `global sample must retain ${imageTile ? "photo" : "type"} piece ${pieceIndex}`,
    );
  }
}

// The clock has to actually run, and restoring has to actually wind it back.
// The module only touches the DOM to enumerate glyphs, so empty layers
// exercise the whole clock on its own.
{
  const {
    createAging,
    ONSET_SPAN_MS,
    RAMP_MS,
    REVOLUTION_MS,
  } = await import("../src/aging.js");
  const makeInk = (character) => {
    const properties = new Map();
    return {
      dataset: {},
      textContent: character,
      style: {
        width: "",
        setProperty(name, value) {
          properties.set(name, value);
        },
        removeProperty(name) {
          properties.delete(name);
        },
      },
      getBoundingClientRect() {
        return { width: 8 };
      },
      removeAttribute(name) {
        if (name.startsWith("data-")) this.dataset[name.slice(5)] = undefined;
      },
    };
  };
  const inks = ["A", "B", "C", "D"].map(makeInk);
  const tokens = inks.map((ink, index) => ({
    dataset: { glyphKey: `clock-test:${index}` },
    querySelector: () => ink,
  }));
  const layers = [
    { querySelectorAll: () => tokens },
    { querySelectorAll: () => [] },
  ];
  let lastMetadata = null;
  const dial = createAging({
    layers,
    palette: {},
    performance: { maxWritesPerTick: 1 },
    onState: (_state, metadata) => {
      lastMetadata = metadata;
    },
  });
  const fullyAged = ONSET_SPAN_MS + RAMP_MS * 2;
  dial.setElapsed(fullyAged);
  assert.equal(
    inks.filter((ink) => ink.dataset.corrupt !== undefined).length,
    1,
    "budgeted dial movement must limit synchronous glyph writes",
  );
  let settlePasses = 0;
  while (!dial.reconcile() && settlePasses < 10) settlePasses += 1;
  assert.equal(
    inks.filter((ink) => ink.dataset.corrupt !== undefined).length,
    inks.length,
    "chunked release reconciliation must finish every pending glyph",
  );
  assert.ok(settlePasses > 0, "a large seek should require more than one bounded pass");
  assert.deepEqual(lastMetadata, { settle: true, settled: true });
  dial.setElapsed(REVOLUTION_MS * 2.5, { immediate: true });
  assert.equal(dial.state.elapsed, REVOLUTION_MS * 2.5);
  assert.equal(dial.state.seconds, REVOLUTION_MS * 2.5 / 1000);
  assert.equal(dial.state.turns, 2.5);
  const validElapsed = dial.state.elapsed;
  dial.setElapsed(Number.POSITIVE_INFINITY, { immediate: true });
  assert.equal(dial.state.elapsed, validElapsed, "non-finite clock input must be ignored");
  dial.setElapsed(-5000, { immediate: true });
  assert.equal(dial.state.elapsed, 0);
  assert.equal(dial.state.turns, 0);
  for (const ink of inks) {
    assert.equal(ink.dataset.corrupt, undefined);
    assert.equal(ink.dataset.glyph, undefined);
    assert.equal(ink.style.width, "");
  }
  dial.setElapsed(fullyAged, { immediate: true });
  assert.equal(
    inks.filter((ink) => ink.dataset.corrupt !== undefined).length,
    inks.length,
    "winding forward again must retrace the preserved corruption schedule",
  );
  dial.destroy();
}

{
  const { createAging } = await import("../src/aging.js");
  const emptyLayers = [{ querySelectorAll: () => [] }, { querySelectorAll: () => [] }];
  const settle = (ms) => new Promise((done) => setTimeout(done, ms));

  const clock = createAging({ layers: emptyLayers, palette: {}, onState: () => {} });
  clock.start();
  clock.setActive(true);
  await settle(1400);
  assert.ok(clock.state.elapsed > 0, "the clock must advance on its own");
  assert.ok(clock.state.turns > 0);
  clock.reset();
  assert.equal(clock.state.elapsed, 0, "a reset must return the clock to zero");
  assert.equal(clock.state.turns, 0);
  clock.destroy();
}

console.log("Loong Basin motion-page contracts passed.");
