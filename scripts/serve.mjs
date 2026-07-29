import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIES } from "../src/data.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 3000);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".avif": "image/avif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
};
const publicAssets = new Set([
  "/website-preview.png",
  "/oriental-loong-mask.avif",
  "/cursive-long-mask.png",
  "/lawrence-1.jpg",
  "/lawrence-2.jpg",
  "/lawrence-3.jpg",
  "/cv.pdf",
  "/favicon-32.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/codex-logo.png",
  "/claude-logo.png",
  "/google-scholar.svg",
  "/github.svg",
  "/linkedin.svg",
]);
const routes = new Set([
  "/",
  ...STUDIES.flatMap(({ slug }) => [`/experiment/${slug}`, `/experiment/${slug}/`]),
]);

createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", `http://${request.headers.host}`).pathname;
  const sourcePath = publicAssets.has(pathname)
    ? resolve(root, "public", pathname.slice(1))
    : pathname === "/styles.css"
      ? resolve(root, "src", "styles.css")
      : pathname.endsWith(".js")
        ? resolve(root, "src", pathname.slice(1))
        : routes.has(pathname)
          ? resolve(root, "index.html")
          : null;
  try {
    if (!sourcePath) throw new Error("Unknown route");
    await stat(sourcePath);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": types[extname(sourcePath)] || "application/octet-stream",
    });
    if (sourcePath.endsWith("index.html")) {
      const shell = await readFile(sourcePath, "utf8");
      response.end(shell
        .replaceAll("__SITE_ORIGIN__", `http://localhost:${port}`)
        .replaceAll("__ASSET_VERSION__", "dev"));
      return;
    }
    createReadStream(sourcePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Local: http://localhost:${port}/`);
});
