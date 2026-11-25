import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const revision = "43cb262cd32fe5f027c029dc6621694d4eff0d35";
const root = `https://raw.githubusercontent.com/WangZhewei1027/ArgusAR/${revision}`;
const files = [
  ["dist/argus_ar.js", "argus_ar.js", "94eb02965680436b2b1209ed6b8b1ac3874f41749b6219e56f9682af633462b1"],
  ["dist/argus_ar.wasm", "argus_ar.wasm", "44a0ce97a6270868d2a97c84f987b292533a2aa0796e63db3f57866a9160bf4d"],
  ["LICENSE", "LICENSE", "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"],
];

await mkdir(new URL("../web/vendor/argus/", import.meta.url), { recursive: true });
for (const [source, destination, expected] of files) {
  const response = await fetch(`${root}/${source}`);
  if (!response.ok) throw new Error(`Failed to download ${source}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${source}`);
  await writeFile(new URL(`../web/vendor/argus/${destination}`, import.meta.url), bytes);
  console.log(`Installed ${destination}`);
}
