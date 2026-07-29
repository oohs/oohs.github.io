import { STUDIES, getFaces, getStudy } from "./data.js?v=__ASSET_VERSION__";
import { mountMatterExperience } from "./motion.js?v=__ASSET_VERSION__";

const app = document.querySelector("#app");
let destroyExperience = null;

function renderNotFound() {
  document.title = "Not found — Lawrence Long";
  app.innerHTML = `
    <article class="home-page">
      <h1>404</h1>
      <p>This conformation does not exist.</p>
      <p><a href="/">Return home</a></p>
    </article>`;
}

async function renderStudy(study) {
  const faces = getFaces(study.slug);
  document.title = "Lawrence Long";
  app.innerHTML = `
    <article
      class="matter-experience"
      data-face="a"
      data-mode="${study.mode}"
      data-owner="dom"
      data-phase="stable"
      aria-label="${study.title}, an interactive two-state personal page"
      aria-describedby="page-instruction"
    >
      <div class="semantic-pages">
        <section class="matter-face" data-active="true" data-face="a" aria-hidden="false">
          <div class="default-page">
            <h1>${study.headings[0]}</h1>
            <hr />
            ${faces[0]}
          </div>
        </section>
        <section class="matter-face" data-active="false" data-face="b" aria-hidden="true" inert>
          <div class="default-page">
            <h1>${study.headings[1]}</h1>
            <hr />
            ${faces[1]}
          </div>
        </section>
      </div>

      <canvas class="local-canvas" aria-hidden="true"></canvas>
      <canvas class="global-canvas" aria-hidden="true"></canvas>

      <div class="disturb-track" aria-hidden="true"><i class="disturb-fill"></i></div>

      <header class="experience-chrome" data-ui>
        <div class="page-motto">
          <p class="page-motto-title">aging is information corruption.</p>
          <p class="page-motto-instruction page-motto-stable" id="page-instruction">The page ages and its text corrupts naturally (or turn the clock hand to speed up aging). Reverse the age by perturbing the text. Above a certain perturbation threshold (or if you press space), you will be able to reprogram the page to an entirely different state!</p>
          <p class="page-motto-instruction page-motto-midpoint">Congrats, you've reprogrammed the page! Perturb the dragon to reveal the next state.</p>
        </div>

        <nav class="experiment-nav" aria-label="Page age and sound">
          <button type="button" class="sound-control" aria-pressed="false" aria-label="Enable sound">
            <span class="sound-control-icon" aria-hidden="true">♪</span>
            <span class="sound-control-label" aria-hidden="true">sound</span>
          </button>
          <span
            class="age-clock-control"
            role="spinbutton"
            tabindex="0"
            aria-label="Page age"
            aria-valuemin="0"
            aria-valuenow="0"
            aria-valuetext="this page is 0:00 old"
            aria-disabled="true"
            title="Drag clockwise to age the page; drag counter-clockwise to reverse it"
          >
            <svg class="age-clock" viewBox="0 0 100 100" aria-hidden="true">
              <circle class="age-clock-rim" cx="50" cy="50" r="45" />
              <g class="age-clock-ticks">${
                Array.from({ length: 12 }, (_, index) => {
                  const angle = (index * 30 - 90) * Math.PI / 180;
                  const inner = index % 3 === 0 ? 36 : 41;
                  const point = (radius) => [
                    (50 + Math.cos(angle) * radius).toFixed(2),
                    (50 + Math.sin(angle) * radius).toFixed(2),
                  ];
                  const [x1, y1] = point(inner);
                  const [x2, y2] = point(44);
                  const cardinal = index % 3 === 0 ? ' class="age-clock-cardinal"' : "";
                  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${cardinal} />`;
                }).join("")
              }</g>
              <line class="age-clock-hand" x1="50" y1="57" x2="50" y2="12" />
              <circle class="age-clock-pin" cx="50" cy="50" r="2.8" />
            </svg>
          </span>
          <output class="age-status" aria-live="off">this page is 0:00 old</output>
        </nav>
      </header>
    </article>`;

  const root = app.querySelector(".matter-experience");
  const layers = Array.from(root.querySelectorAll(".matter-face"));
  destroyExperience = await mountMatterExperience({
    root,
    layers,
    globalCanvas: root.querySelector(".global-canvas"),
    localCanvas: root.querySelector(".local-canvas"),
    study,
    ageElement: root.querySelector(".age-status"),
    clock: root.querySelector(".age-clock"),
    clockControl: root.querySelector(".age-clock-control"),
    disturbTrack: root.querySelector(".disturb-track"),
    soundButton: root.querySelector(".sound-control"),
  });

  root.addEventListener("keydown", (event) => {
    if (
      event.code === "Space" &&
      event.target === root &&
      !event.target.closest("a, button, input, select, textarea, summary, [contenteditable='true'], [role='button']")
    ) {
      event.preventDefault();
      root.dispatchEvent(new CustomEvent("loong:advance"));
    }
  });
  root.addEventListener("click", (event) => {
    const anchor = event.target.closest("a");
    if (anchor?.getAttribute("href") === "#") event.preventDefault();
  });
  root.tabIndex = 0;
}

const pieces = location.pathname.split("/").filter(Boolean);
if (!pieces.length) {
  await renderStudy(STUDIES[0]);
} else if (pieces.length === 2 && pieces[0] === "experiment") {
  const study = getStudy(pieces[1]);
  if (study) await renderStudy(study);
  else renderNotFound();
} else {
  renderNotFound();
}

addEventListener("beforeunload", () => destroyExperience?.(), { once: true });
