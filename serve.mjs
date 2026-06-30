// Minimal zero-dependency static server.
// The renderer is plain ES modules + fetch, so it must be served over HTTP
// (file:// blocks both). This serves the project root.
//
//   npm start   ->   http://localhost:5173
//
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/") urlPath = "/index.html";
    // Resolve safely inside ROOT.
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    // ETag from size + mtime lets the client revalidate cheaply: an unchanged
    // bracket.json comes back as a bodyless 304 instead of a fresh download.
    const etag = `"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
    const isBracket = filePath.endsWith("bracket.json");
    const cache = isBracket ? "no-cache" : "public, max-age=60";

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": cache });
      res.end();
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, ETag: etag });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`World Cup 26 bracket  ->  http://localhost:${PORT}`);
});
