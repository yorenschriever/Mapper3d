import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { nodePool } from "../scripts/node-pool.js";
import { scanMoving, scanStationary } from "../web/scan.js";
import { framesFromTracks, modelToJson, reconstruct } from "../web/reconstruct.js";
import { MAX_BUNDLE_POINTS } from "../web/config.js";
import { toHpp } from "../web/ui/export.js";

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
      const result = await scanStationary(() => readFrames(annotation.width, annotation.height, seconds));
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

async function* readMovingFrames(video = movingVideo, seconds = null) {
  const width = 1280, height = 720, frameBytes = width * height * 4;
  const times = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video],
    { encoding: "utf8", maxBuffer: 1e8 }).trim().split("\n").map(t => Number(t) * 1000);
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-i", video, ...(seconds === null ? [] : ["-t", String(seconds)]),
    "-f", "rawvideo", "-pix_fmt", "rgba", "-fps_mode", "passthrough", "-"],
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
    const result = await scanMoving(readMovingFrames(), { analyze: frame => pool.analyze(frame), concurrency: pool.size + 2 });
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

test("reconstructs lights outside the bundle-adjustment subset", { timeout: 120000 }, () => {
  const width = 1280, height = 720, focal = 0.66 * width;
  const points = Array.from({ length: 121 }, (_, i) => [
    (i % 11 - 5) * 0.15,
    (Math.floor(i / 11) - 5) * 0.12,
    3 + ((i * 17) % 31) / 20,
  ]);
  const frames = Array.from({ length: 24 }, (_, k) => {
    const observations = new Map(points.map(([x, y, z], id) => [id, [{
      x: width / 2 + focal * (x - k * 0.025) / z,
      y: height / 2 + focal * (y - k * 0.004) / z,
      margin: 10,
    }]]));
    return { time: k * 100, observations };
  });
  const logs = [];
  const model = reconstruct(frames, { width, height, focal, log: message => logs.push(message) });
  assert.ok(logs.includes(`bundle adjustment: ${Math.min(MAX_BUNDLE_POINTS, points.length)} selected lights`));
  assert.equal(model.points.size, points.length);
  assert.ok(model.medianError < 1, `median reprojection error ${model.medianError}`);
});

test("uses a labeled single-view projection when rotation cannot establish depth", () => {
  const width = 1280, height = 720, focal = 0.66 * width;
  const points = Array.from({ length: 20 }, (_, i) => [(i % 5 - 2) * 0.3, (Math.floor(i / 5) - 2) * 0.25, 3 + (i * 7 % 9) * 0.1]);
  const frames = Array.from({ length: 20 }, (_, k) => ({
    time: k,
    observations: new Map(points.slice(0, k === 4 ? 20 : 19).map(([x, y, z], id) => {
      const angle = k * 0.01, X = Math.cos(angle) * x + Math.sin(angle) * z, Z = -Math.sin(angle) * x + Math.cos(angle) * z;
      return [id, [{ x: width / 2 + focal * X / Z, y: height / 2 + focal * y / Z, margin: 10 }]];
    })),
  }));
  const model = reconstruct(frames, { width, height, focal });
  assert.equal(model.kind, "projection");
  assert.equal(model.points.size, 20);
  assert.equal(model.cameras.length, 0);
  assert.ok([...model.points.values()].every(p => p[2] === 0));
  const json = modelToJson(model, { count: 21, width, height });
  assert.equal(json.kind, "projection");
  assert.equal(json.medianError, null);
  const header = toHpp(json);
  assert.match(header, /Approximate single-view projection/);
  assert.match(header, /NAN, NAN, NAN.*20/);
});

test("does not produce a projection when no lights were decoded", () => {
  assert.throws(() => reconstruct([], { width: 1280, height: 720 }), /Not enough camera movement or shared lights/);
});

const denseVideo = fileURLToPath(new URL("./test_data/20261127_182023.mp4", import.meta.url));

test("decodes densely spaced lights from the 500-light recording",
  { skip: !existsSync(denseVideo), timeout: 900000 }, async () => {
    const pool = nodePool(4);
    try {
      const result = await scanMoving(readMovingFrames(denseVideo, 10), {
        analyze: frame => pool.analyze(frame, { separation: 4, maxSpots: 1000 }),
        concurrency: pool.size + 2, maxTracks: 1500,
      });
      assert.equal(result.count, 500);
      const indices = new Set(result.tracks.map(t => t.index));
      assert.ok(indices.size >= 450, `${indices.size} distinct indices decoded`);
      assert.ok([...indices].every(i => i >= 0 && i < 500));
    } finally {
      pool.terminate();
    }
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
      result = await scanMoving(readPhoneFrames(), { analyze: frame => pool.analyze(frame), concurrency: pool.size + 2 });
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
