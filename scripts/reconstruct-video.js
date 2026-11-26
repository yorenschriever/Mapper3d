// Tracklets are cached next to the output (<output>.cache.json), so reruns skip the video.
// Usage: node scripts/reconstruct-video.js <video> <output.json> [width height]
// Scans a handheld recording, reconstructs the lights in 3D and writes a model for web/viewer.html.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { scanMoving } from "../web/scan.js";
import { nodePool } from "./node-pool.js";
import { fileCache } from "./file-cache.js";
import { framesFromTracks, modelToJson, reconstruct } from "../web/reconstruct.js";

const [video, output, w, h] = process.argv.slice(2);
if (!video || !output) { console.error("Usage: node scripts/reconstruct-video.js <video> <output.json> [width height]"); process.exit(2); }
const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video], { encoding: "utf8" }).trim().split(",").map(Number);
const width = Number(w) || probe[0], height = Number(h) || probe[1];
const times = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video],
  { encoding: "utf8", maxBuffer: 1e8 }).trim().split("\n").map(t => Number(t) * 1000);

async function* frames() {
  const bytes = width * height * 4;
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgba", "-fps_mode", "passthrough", "-"], { stdio: ["ignore", "pipe", "inherit"] });
  let frame = Buffer.allocUnsafe(bytes), filled = 0, n = 0;
  for await (const chunk of ffmpeg.stdout) {
    for (let at = 0; at < chunk.length;) {
      const take = Math.min(bytes - filled, chunk.length - at);
      chunk.copy(frame, filled, at, at + take);
      filled += take; at += take;
      if (filled === bytes) {
        yield { width, height, data: frame, time: times[n++] };
        frame = Buffer.allocUnsafe(bytes); filled = 0;
      }
    }
  }
}

const pool = nodePool();
const stat = statSync(video);
const started = performance.now();
const scan = await scanMoving(frames, {
  periods: [120],
  analyze: frame => pool.analyze(frame, JSON.parse(process.env.ANALYZE_OPTIONS ?? "{}")),
  concurrency: 2 * pool.size,
  cache: fileCache(`${output}.cache.json`),
  cacheKey: `${video}:${stat.size}:${stat.mtimeMs}`,
});
pool.terminate();
console.log(`scan ${((performance.now() - started) / 1000).toFixed(1)}s`);
console.log(`decoded ${scan.tracks.length} tracklets, count ${scan.count}`);
const model = reconstruct(framesFromTracks(scan.tracks, 4), { width, height, log: console.log });
writeFileSync(output, JSON.stringify(modelToJson(model, { count: scan.count, width, height })));
console.log(`wrote ${output}: ${model.points.size} lights, ${model.cameras.length} cameras, rms ${model.rms.toFixed(2)}px, median ${model.medianError.toFixed(2)}px`);
