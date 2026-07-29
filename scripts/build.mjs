import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIES } from "../src/data.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const shellTemplate = await readFile(resolve(root, "index.html"), "utf8");
const ogImage = await readFile(resolve(root, "public", "website-preview.png"));
const ogBase64 = ogImage.toString("base64");
const runtimeAssetFiles = [
  ["oriental-loong-mask.avif", "image/avif"],
  ["cursive-long-mask.png", "image/png"],
  ["lawrence-1.jpg", "image/jpeg"],
  ["lawrence-2.jpg", "image/jpeg"],
  ["lawrence-3.jpg", "image/jpeg"],
  ["cv.pdf", "application/pdf"],
  ["favicon-32.png", "image/png"],
  ["icon-512.png", "image/png"],
  ["apple-touch-icon.png", "image/png"],
  ["codex-logo.png", "image/png"],
  ["claude-logo.png", "image/png"],
  ["google-scholar.svg", "image/svg+xml"],
  ["github.svg", "image/svg+xml"],
  ["linkedin.svg", "image/svg+xml"],
];
const runtimeAssets = await Promise.all(runtimeAssetFiles.map(async ([filename, contentType]) => ({
  filename,
  contentType,
  base64: (await readFile(resolve(root, "public", filename))).toString("base64"),
})));
// Every module under src/ ships. Enumerating the directory rather than listing
// files by hand means a new subsystem is picked up by the worker bundle and the
// cache-busting hash without anyone having to remember this file exists.
const moduleNames = (await readdir(resolve(root, "src")))
  .filter((name) => name.endsWith(".js"))
  .sort();
const modules = await Promise.all(moduleNames.map(async (name) => [
  name,
  await readFile(resolve(root, "src", name), "utf8"),
]));
const sources = new Map(modules);
const mainTemplate = sources.get("main.js");
const styles = await readFile(resolve(root, "src", "styles.css"), "utf8");
const assetVersion = modules
  .reduce((hash, [, source]) => hash.update(source), createHash("sha256"))
  .update(styles)
  .digest("hex")
  .slice(0, 12);
const shell = shellTemplate.replaceAll("__ASSET_VERSION__", assetVersion);
const siteOrigin = process.env.SITE_ORIGIN?.replace(/\/+$/, "");
const staticShell = siteOrigin
  ? shell.replaceAll("__SITE_ORIGIN__", siteOrigin)
  : shell;
const main = mainTemplate.replaceAll("__ASSET_VERSION__", assetVersion);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, "index.html"), staticShell);
await cp(resolve(root, "src"), dist, { recursive: true });
await writeFile(resolve(dist, "main.js"), main);
await cp(
  resolve(root, "public", "website-preview.png"),
  resolve(dist, "website-preview.png"),
);
await Promise.all(runtimeAssets.map(({ filename }) => (
  cp(resolve(root, "public", filename), resolve(dist, filename))
)));

for (const study of STUDIES) {
  const directory = resolve(dist, "experiment", study.slug);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "index.html"), staticShell);
}

const routeList = [
  "/",
  ...STUDIES.flatMap(({ slug }) => [
    `/experiment/${slug}`,
    `/experiment/${slug}/`,
  ]),
];
const workerSource = `
const shell = ${JSON.stringify(shell)};
const ogBase64 = ${JSON.stringify(ogBase64)};
const ogImage = Uint8Array.from(atob(ogBase64), (character) => character.charCodeAt(0));
const runtimeAssets = new Map(${JSON.stringify(runtimeAssets.map(({ filename, contentType, base64 }) => [
  `/${filename}`,
  [base64, contentType],
]))});
const routes = new Set(${JSON.stringify(routeList)});
const assets = new Map([
${modules.map(([name, source]) => `  ["/${name}", [${
  JSON.stringify(name === "main.js" ? main : source)
}, "text/javascript; charset=utf-8"]],`).join("\n")}
  ["/styles.css", [${JSON.stringify(styles)}, "text/css; charset=utf-8"]],
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/website-preview.png") {
      return new Response(request.method === "HEAD" ? null : ogImage, {
        status: 200,
        headers: {
          "cache-control": "public, max-age=86400",
          "content-type": "image/png",
        },
      });
    }
    const runtimeAsset = runtimeAssets.get(pathname);
    if (runtimeAsset) {
      const body = request.method === "HEAD"
        ? null
        : Uint8Array.from(atob(runtimeAsset[0]), (character) => character.charCodeAt(0));
      return new Response(body, {
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": runtimeAsset[1],
        },
      });
    }
    const asset = assets.get(pathname);
    if (asset) {
      return new Response(request.method === "HEAD" ? null : asset[0], {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": asset[1],
        },
      });
    }
    if (routes.has(pathname)) {
      const page = shell.replaceAll("__SITE_ORIGIN__", url.origin);
      return new Response(request.method === "HEAD" ? null : page, {
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
`;
await mkdir(resolve(dist, "server"), { recursive: true });
await writeFile(resolve(dist, "server", "index.js"), workerSource.trimStart());

try {
  await mkdir(resolve(dist, ".openai"), { recursive: true });
  await cp(
    resolve(root, ".openai", "hosting.json"),
    resolve(dist, ".openai", "hosting.json"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await rm(resolve(dist, ".openai"), { recursive: true, force: true });
}

console.log(`Built ${STUDIES.length + 1} static routes in ${dist}`);
