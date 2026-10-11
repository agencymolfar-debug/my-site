// Minimal static server for Railway. Serves files from this folder, no dependencies.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon" };
const hidden = new Set(["server.js", "package.json"]);

http.createServer(async (req, res) => {
  const [rawPath, query] = (req.url || "/").split("?");
  let path = decodeURIComponent(rawPath);
  // "/listv1" -> "/listv1/" (keeps ?utm_...&fbclid=... so ad tracking survives the redirect)
  if (!path.endsWith("/") && !extname(path)) {
    res.writeHead(301, { Location: rawPath + "/" + (query ? "?" + query : "") }).end();
    return;
  }
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(path).replace(/^([/\\])+/, "");
  if (file.includes("..") || file.startsWith(".") || hidden.has(file)) { res.writeHead(404).end("Not found"); return; }
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(process.env.PORT || 8080, "0.0.0.0");
