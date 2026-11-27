import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { nodePool } from "../scripts/node-pool.js";
import { scanMoving, scanStationary } from "../web/scan.js";
import { framesFromTracks, reconstruct } from "../web/reconstruct.js";

const video = fileURLToPath(new URL("./test_data/protocolv2.mp4", import.meta.url));
const annotationFile = fileURLToPath(new URL("./test_data/protocolv2.leds.json", import.meta.url));
const FPS = 60;

async function* readFrames(width, height, seconds) {
  const frameBytes = width * height * 4;
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-i", video, "-t", String(seconds), "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = Buffer.allocUnsafe(frameBytes), filled = 0, frame = 0;
  for await (const chunk of ffmpeg.stdout) {
    for (let at = 0; at < chunk.length;) {
      const take = Math.min(frameBytes - filled, chunk.length - at);
      chunk.copy(buffer, filled, at, at + take);
      filled += take; at += take;
      if (filled === frameBytes) {
        yield { width, height, data: buffer, time: frame++ * 1000 / FPS };
        buffer = Buffer.allocUnsafe(frameBytes); filled = 0;
      }
    }
  }
}

test("finds and decodes every light of a stationary protocol v2 recording on its own",
  { skip: !existsSync(video) || !existsSync(annotationFile), timeout: 600000 }, async () => {
    const annotation = JSON.parse(readFileSync(annotationFile, "utf8"));
    for (const seconds of [32, 8]) {
      const result = await scanStationary(() => readFrames(annotation.width, annotation.height, seconds), { periods: [120] });
      assert.equal(result.count, annotation.ledCount);
      assert.equal(result.lights.length, annotation.ledCount, `lights found in ${seconds}s`);
      for (const led of annotation.leds) {
        const found = result.lights.find(l => l.index === led.index);
        assert.ok(found, `LED ${led.index} decoded`);
        assert.ok(Math.hypot(found.x - led.x, found.y - led.y) < 12, `LED ${led.index} position`);
      }
    }
  });

const movingVideo = fileURLToPath(new URL("./test_data/protocolv2_moving.mp4", import.meta.url));

async function* readMovingFrames() {
  const width = 1280, height = 720, frameBytes = width * height * 4;
  const times = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", movingVideo],
    { encoding: "utf8", maxBuffer: 1e8 }).trim().split("\n").map(t => Number(t) * 1000);
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-i", movingVideo, "-f", "rawvideo", "-pix_fmt", "rgba", "-fps_mode", "passthrough", "-"],
    { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = Buffer.allocUnsafe(frameBytes), filled = 0, frame = 0;
  for await (const chunk of ffmpeg.stdout) {
    for (let at = 0; at < chunk.length;) {
      const take = Math.min(frameBytes - filled, chunk.length - at);
      chunk.copy(buffer, filled, at, at + take);
      filled += take; at += take;
      if (filled === frameBytes) {
        yield { width, height, data: buffer, time: times[frame++] };
        buffer = Buffer.allocUnsafe(frameBytes); filled = 0;
      }
    }
  }
}

test("decodes all 20 lights of a recording with a moving camera and reconstructs them in 3D",
  { skip: !existsSync(movingVideo), timeout: 900000 }, async () => {
    const pool = nodePool();
    const result = await scanMoving(readMovingFrames(), { periods: [120], analyze: frame => pool.analyze(frame), concurrency: pool.size + 2 });
    pool.terminate();
    assert.equal(result.count, 20);
    const indices = new Set(result.tracks.map(t => t.index));
    for (let i = 0; i < 20; i++) assert.ok(indices.has(i), `LED ${i} decoded`);
    assert.ok([...indices].every(i => i < 20));

    const model = reconstruct(framesFromTracks(result.tracks, 4), { width: 1280, height: 720 });
    assert.equal(model.points.size, 20);
    assert.ok(model.cameras.length > 150, `${model.cameras.length} cameras registered`);
    assert.ok(model.medianError < 2, `median reprojection error ${model.medianError}`);
    const spacing = [];
    for (let i = 1; i < 20; i++) spacing.push(Math.hypot(...model.points.get(i).map((v, k) => v - model.points.get(i - 1)[k])));
    const mean = spacing.reduce((a, b) => a + b) / spacing.length;
    const deviation = Math.sqrt(spacing.reduce((s, v) => s + (v - mean) ** 2, 0) / spacing.length);
    assert.ok(deviation / mean < 0.35, `neighbor spacing varies by ${(deviation / mean).toFixed(2)}`);
  });
