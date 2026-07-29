import { formatLiveAge } from "./live-age.js";

// The real age is present in the first rendered markup—there is no zero-value
// loading placeholder. motion.js keeps these fixed-width digits current after
// they have been tokenised for corruption and transitions.
const liveAge = `<span class="live-age">${formatLiveAge()}</span>`;

const publications = `
  <h2>Featured publications</h2>
  <p>Xu, P.*; <b>Long, L.Y.</b>*; et al.; Faure, G.† &amp; Zhang, F.† (2026). “RNA-guided transcriptional repression by TIGR-Tas systems.” <i>In revision at Nature Microbiology</i>. (* equal contribution)</p>
  <p>Paggi, J.M.; <b>Long, L.Y.</b>; Zhang, B. (2026). “Euchromatin forms condensed domains with short active regions on the surface.” <i>Accepted at Nature Genetics</i>.</p>
  <p>Ahn, R.; D’Souza, A.D.; <b>Long, L.Y.</b>; et al.; White, F.M. (2026). “Uncovering the signaling networks of disseminated glioblastoma cells <i>in vivo</i> with INSIGHT.” <i>Accepted at Nature Communications</i>.</p>
  <p class="publication-more">(see full list on
    <a class="brand-link" href="https://scholar.google.com/citations?user=AkYzW8IAAAAJ&amp;hl=en" target="_blank" rel="noopener" aria-label="Google Scholar" title="Google Scholar">
      <span class="brand-icon-frame">
        <img class="brand-icon" src="/google-scholar.svg" alt="" aria-hidden="true" width="24" height="24" data-diffuse data-diffuse-whole data-diffuse-tiles="25" />
      </span>
    </a>)
  </p>`;

const contacts = `
  <h2>Contact</h2>
  <p>I’m always happy to connect with people! Especially if you are good at ping pong and in the Boston area, hmu! ;)</p>
  <p class="contact-links">
    <a href="/cv.pdf">CV</a>
    <a class="brand-link" href="https://github.com/oohs" target="_blank" rel="noopener" aria-label="GitHub" title="GitHub">
      <span class="brand-icon-frame">
        <img class="brand-icon" src="/github.svg" alt="" aria-hidden="true" width="24" height="24" data-diffuse data-diffuse-whole data-diffuse-tiles="25" />
      </span>
    </a>
    <a class="brand-link" href="https://www.linkedin.com/in/lawrenceylong" target="_blank" rel="noopener" aria-label="LinkedIn" title="LinkedIn">
      <span class="brand-icon-frame">
        <img class="brand-icon" src="/linkedin.svg" alt="" aria-hidden="true" width="24" height="24" data-diffuse data-diffuse-whole data-diffuse-tiles="25" />
      </span>
    </a>
  </p>
  <p class="contact-email">email: belong at mit dot edu</p>`;

const currentYear = new Date().getFullYear();
const pageFooter = `
  <footer class="page-footer">
    <span class="page-footer-credit">
      made with imagination
      <span class="page-footer-help">(with help from
        <span class="footer-logo-frame">
          <img class="footer-logo" src="/codex-logo.png" alt="Codex" title="Codex" width="128" height="128" data-diffuse data-diffuse-whole data-diffuse-tiles="25" />
        </span>
        and
        <span class="footer-logo-frame">
          <img class="footer-logo" src="/claude-logo.png" alt="Claude" title="Claude" width="128" height="128" data-diffuse data-diffuse-whole data-diffuse-tiles="25" />
        </span>)
      </span>
    </span>
    <span class="page-footer-copyright">© <time datetime="${currentYear}">${currentYear}</time> Lawrence Long</span>
  </footer>`;

const selectedWork = `
  <h2>Selected research</h2>
  <p><b>Bin Zhang Group, MIT Chemistry.</b> I work with high-resolution Micro-C data and polymer models of chromatin. My projects have included improving contact-map balancing, testing maximum-entropy inversion, and studying local folding in active chromatin across mitosis.</p>
  <p><b>Feng Zhang Lab, Broad Institute.</b> I’ve built computational tools for finding RNA-guided systems in genomes, including TIGRFinder, and explored language-model approaches to peptide activity, cleavage, and agentic biological discovery.</p>
  <p><b>Forest White Lab, Koch Institute.</b> I studied signaling networks in glioblastoma with multi-omic data and cell type abundance deconvolution from proteomics.</p>`;

const aboutFace = `
  <figure class="page-photo">
    <span class="photo-frame"><img src="/lawrence-1.jpg" alt="Lawrence Long" width="825" height="1100" data-diffuse /></span>
    <figcaption>pic taken by my talented gf in montreal</figcaption>
  </figure>
  <p class="opening-line">Hi, I’m Lawrence Long, currently <em>${liveAge}</em> years old.</p>
  <h2>Now</h2>
  <p>I’m an incoming PhD student in the Harvard–MIT HST MEMP program. I’m interested in deciphering the molecular mechanisms of aging and understanding aging in the context of cellular states, with the goal of developing methods for reversing cellular aging.</p>
  <p>Graduated from MIT in 2026 in physics and computer science, with a math minor.</p>
  <p class="research-question">I like thinking about hard problems from a myriad of perspectives, pulling in ideas from physics, AI, biology, and other places to understand “why do we age?”</p>
  ${selectedWork}
  ${publications}
  ${contacts}
  ${pageFooter}`;

const interestingCourses = `
  <section class="coursework" aria-labelledby="coursework-heading">
    <h2 id="coursework-heading">Interesting courses taken</h2>
    <p class="coursework-note">Italicized courses are my favorites.</p>
    <div class="coursework-groups">
      <section class="course-level" aria-labelledby="grad-coursework-heading">
        <h3 id="grad-coursework-heading">Grad-level:</h3>
        <dl class="course-list">
          <dt>6.7960</dt><dd>Deep Learning</dd>
          <dt>6.7920</dt><dd>Reinforcement Learning</dd>
          <dt>8.323</dt><dd>Relativistic Quantum Field Theory</dd>
          <dt><em>9.123</em></dt><dd><em>Neurotechnology in Action</em></dd>
          <dt><em>18.436</em></dt><dd><em>Quantum Information Science</em></dd>
          <dt>20.363</dt><dd>Biomaterials Science and Engineering</dd>
        </dl>
      </section>
      <section class="course-level" aria-labelledby="undergrad-coursework-heading">
        <h3 id="undergrad-coursework-heading">Undergrad-level:</h3>
        <dl class="course-list">
          <dt>5.04</dt><dd>Principles of Inorganic Chemistry II</dd>
          <dt>5.13</dt><dd>Organic Chemistry II</dd>
          <dt>6.1220</dt><dd>Design and Analysis of Algorithms</dd>
          <dt>8.044</dt><dd>Statistical Physics I</dd>
          <dt>8.05</dt><dd>Quantum Physics II</dd>
          <dt><em>8.225</em></dt><dd><em>Physics in the 20th Century</em></dd>
          <dt><em>8.251</em></dt><dd><em>String Theory for Undergraduates</em></dd>
          <dt>14.12</dt><dd>Economic Applications of Game Theory</dd>
          <dt>14.39</dt><dd>Large-Scale Decision-Making and Inference</dd>
          <dt><em>20.309</em></dt><dd><em>Biological Instrumentation and Measurement</em></dd>
        </dl>
      </section>
    </div>
  </section>`;

const workFace = `
  <figure class="page-photo">
    <span class="photo-frame"><img src="/lawrence-2.jpg" alt="Lawrence Long playing table tennis" width="1100" height="880" data-diffuse /></span>
    <figcaption>westchester tourney, credits to boris tsang goated photographer</figcaption>
  </figure>
  <figure class="page-photo">
    <span class="photo-frame"><img src="/lawrence-3.jpg" alt="Lawrence Long beside a bodybuilder cutout in Japan" width="825" height="1100" data-diffuse /></span>
    <figcaption>got swole in japan.</figcaption>
  </figure>
  <h2>Teaching and community</h2>
  <p>Through the USA Biology Olympiad (USABO) and Baology tutoring, I’ve written competition questions and taught high school students. I was a USABO finalist in 2021 and 2022 and was selected to represent USA in 2022 (albeit, the US did not attend the 2022 International Biology Olympiad due to COVID concerns).</p>
  <p>I am very passionate about teaching. “If you cannot explain something in simple terms, you don’t understand it. The best way to learn is to teach.”</p>
  <h2>Outside the lab</h2>
  <p>I love table tennis (go MIT Table Tennis club!), and I’m also an avid gym-goer. These days, I’ve also been basketball-ing and pickle-ing. When I’m tired of sweating (and research), you can find me learning French and Arabic on Duolingo or twiddling with a Rubik’s cube (sub-15 avg these days).</p>
  <p>As you probably tell by this website, I would classify myself as a sweaty vibe-coder.</p>
  ${interestingCourses}
  ${contacts}
  ${pageFooter}`;

export const STUDIES = [
  {
    number: "01",
    slug: "dragon-eye-basin",
    title: "Loong Basin",
    mode: "sigil-eye",
    durationMs: 2600,
    resolveMs: 2200,
    // Charge needed to change state, and how long a character waits before it
    // can contribute again. With no button on the page these are the only way
    // through, so they are set for a few seconds of deliberate sweeping rather
    // than for the frantic scrub the old windowed gate demanded.
    requiredCharacters: 620,
    drainMs: 15000,
    windowMs: 2600,
    cursorRadius: 118,
    releaseHoldMs: 620,
    releaseOmega: 4.7,
    midpointRequired: 3000,
    midpointDrainMs: 18000,
    midpointWindowMs: 3400,
    midpointRadius: 138,
    midpointReleaseHoldMs: 820,
    midpointReleaseOmega: 3.8,
    midpoint: "dual-loong",
    midpointVariants: [
      { id: "seal-loong", label: "the 龍 seal" },
    ],
    passiveMidpointMotion: true,
    midpointName: "the 龍 seal",
    midpointUnits: "loong fragments",
    material: "3 × 3 fitted fragments",
    register: "3 × 3 type fragments / orbital current / dual loong attractor",
    description: "Each letter opens into a fitted three-by-three sigil. Two attractor basins exchange the nine pieces, building orbital momentum without changing the letter’s exact resting footprint.",
    midpointDescription: "At the midpoint the page settles into one state: a heavy cursive 龍 standing in front of a loong that fills the frame behind it, washed back so the character reads as foreground.",
    headings: ["Lawrence Long, Page 1", "Lawrence Long, Page 2"],
  },
];

const faces = Object.fromEntries(STUDIES.map((study) => [study.slug, [aboutFace, workFace]]));

export function getStudy(slug) {
  return STUDIES.find((study) => study.slug === slug);
}

export function getFaces(slug) {
  return faces[slug];
}
