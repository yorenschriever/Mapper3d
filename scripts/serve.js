// Usage: node scripts/serve.js [port] [--http]
// Serves web/ over HTTPS on all interfaces with a self-signed certificate, so a phone on the same wifi
// can open it and use the camera (browsers only allow the camera on https or localhost).
import { createServer as createHttps } from "node:https";
import { createServer as createHttp } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../web/", import.meta.url));
const certDir = fileURLToPath(new URL("../.certs/", import.meta.url));
const plain = process.argv.includes("--http");
const port = Number(process.argv.find(a => /^\d+$/.test(a))) || (plain ? 8080 : 8443);
const key = join(certDir, "key.pem"), cert = join(certDir, "cert.pem");
if (!plain && !existsSync(cert)) {
  mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365", "-subj", "/CN=mapper3d",
    "-keyout", key, "-out", cert], { stdio: "ignore" });
}
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".mp4": "video/mp4" };

const handler = (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "https://x").pathname));
  let file = join(root, path === "/" ? "viewer.html" : path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end("Not found"); return; }
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
};
(plain ? createHttp(handler) : createHttps({ key: readFileSync(key), cert: readFileSync(cert) }, handler)).listen(port, "0.0.0.0", () => {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) console.log(`http${plain ? "" : "s"}://${a.address}:${port}/viewer.html`);
  }
  console.log("The certificate is self-signed: accept the browser warning once.");
});
