// Minimal zero-dependency static file server for the built admin SPA (dist/).
// Used as the Railway start command. Serves hashed assets directly and falls
// back to index.html for client-side routes (react-router). No deps so the
// production image stays lean and there's no ESM/CJS interop to trip over.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist", import.meta.url));
const PORT = process.env.PORT || 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function resolveFile(urlPath) {
  // Reject path traversal: the resolved path must stay inside DIST.
  const candidate = join(DIST, normalize(urlPath));
  if (!candidate.startsWith(DIST)) return null;
  if (candidate !== DIST && existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  return null; // SPA fallback handled by caller
}

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = resolveFile(urlPath) ?? join(DIST, "index.html");
    const body = await readFile(file);
    const isIndex = file.endsWith("index.html");
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      // Hashed assets are immutable; never cache the HTML shell.
      "Cache-Control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
}).listen(PORT, () => console.log(`UWC admin static server listening on :${PORT}`));
