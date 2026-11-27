import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
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

const phoneVideo = fileURLToPath(new URL("./test_data/20261126_171504.mp4", import.meta.url));

async function* readPhoneFrames() {
  const width = 1080, height = 1920, frameBytes = width * height * 4;
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "frame=best_effort_timestamp_time", "-of", "json", phoneVideo], { encoding: "utf8", maxBuffer: 1e8 }));
  const times = probe.frames.map(frame => Number(frame.best_effort_timestamp_time) * 1000);
  assert.ok(times.every(Number.isFinite), "every frame has a timestamp");
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-i", phoneVideo, "-f", "rawvideo", "-pix_fmt", "rgba",
    "-fps_mode", "passthrough", "-"], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(ffmpeg, "close");
  let buffer = Buffer.allocUnsafe(frameBytes), filled = 0, frame = 0, finished = false;
  try {
    for await (const chunk of ffmpeg.stdout) for (let at = 0; at < chunk.length;) {
      const take = Math.min(frameBytes - filled, chunk.length - at);
      chunk.copy(buffer, filled, at, at + take);
      filled += take; at += take;
      if (filled === frameBytes) {
        assert.ok(frame < times.length, "each decoded frame has a timestamp");
        yield { width, height, data: buffer, time: times[frame++] };
        buffer = Buffer.allocUnsafe(frameBytes); filled = 0;
      }
    }
    finished = true;
  } finally {
    if (!finished) { ffmpeg.kill(); await closed; }
  }
  const [code] = await closed;
  assert.equal(code, 0, "ffmpeg decoded the recording");
  assert.equal(filled, 0);
  assert.equal(frame, times.length);
}

test("recovers the phone recording's count and reconstructs lights across the focal-refinement gap",
  { skip: !existsSync(phoneVideo), timeout: 900000 }, async () => {
    const pool = nodePool(6);
    let result;
    try {
      result = await scanMoving(readPhoneFrames(), { periods: [120], analyze: frame => pool.analyze(frame), concurrency: pool.size + 2 });
    } finally {
      pool.terminate();
    }
    assert.equal(result.count, 20);
    assert.deepEqual([...new Set(result.tracks.map(t => t.index))].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
    const stages = [];
    const model = reconstruct(framesFromTracks(result.tracks, 4), { width: 1080, height: 1920, onStage: stage => stages.push(stage) });
    assert.equal(model.points.size, 20);
    assert.ok(model.cameras.some(c => c.time < 10000), "registers early frames");
    assert.ok(model.cameras.some(c => c.time > 28000), "registers late frames");
    assert.deepEqual(stages, [
      "Finding a starting viewpoint",
      "Registering camera viewpoints",
      "Refining camera and light positions",
      "Registering remaining viewpoints",
      "Finalizing the model",
    ]);
  });
