import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import cv from "@techstark/opencv-js";
import { BackgroundMotion, detectLights, LightTracker, locateLight, sampleLight } from "../web/led-tracker.js";
import { motionField, MultiLightTracker } from "../web/multi-light-tracker.js";
import { StreamDecoder } from "../web/protocol.js";

test("local contrast detects a light without following a bright uniform background", () => {
  const image = { width: 60, height: 60, data: new Uint8ClampedArray(60 * 60 * 4) };
  for (let i = 0; i < image.data.length; i += 4) image.data.set([180, 130, 100, 255], i);
  assert.equal(locateLight(image, { x: 30, y: 30 }), null);
  for (let y = 28; y <= 32; y++) {
    for (let x = 28; x <= 32; x++) image.data.set([255, 40, 40, 255], (y * 60 + x) * 4);
  }
  const found = locateLight(image, { x: 30, y: 30 });
  assert.ok(found);
  assert.equal(found.color, 0);
  assert.ok(Math.hypot(found.x - 30, found.y - 30) <= 3);
});

test("detects separate colored lights against a bright background", async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const image = { width: 140, height: 80, data: new Uint8ClampedArray(140 * 80 * 4) };
  for (let i = 0; i < image.data.length; i += 4) image.data.set([160, 130, 100, 255], i);
  const lights = [
    { x: 25, y: 30, rgb: [255, 0, 0], color: 0 },
    { x: 70, y: 45, rgb: [0, 255, 0], color: 1 },
    { x: 115, y: 30, rgb: [0, 0, 255], color: 2 },
  ];
  for (const light of lights) {
    for (let y = light.y - 3; y <= light.y + 3; y++) {
      for (let x = light.x - 3; x <= light.x + 3; x++) {
        if (Math.hypot(x - light.x, y - light.y) <= 3)
          image.data.set([...light.rgb, 255], (y * image.width + x) * 4);
      }
    }
  }
  const detections = detectLights(cv, image);
  assert.equal(detections.length, lights.length);
  for (const light of lights) {
    const detection = detections.find(point => Math.hypot(point.x - light.x, point.y - light.y) <= 4);
    assert.equal(detection?.color, light.color);
  }
});

test("samples a weak light at a predicted position without inventing a background color", async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const image = { width: 60, height: 60, data: new Uint8ClampedArray(60 * 60 * 4) };
  for (let i = 0; i < image.data.length; i += 4) image.data.set([40, 40, 40, 255], i);
  assert.deepEqual(sampleLight(image, { x: 30, y: 30 }), { color: null });
  for (let y = 28; y <= 32; y++) {
    for (let x = 28; x <= 32; x++) image.data.set([90, 40, 40, 255], (y * 60 + x) * 4);
  }
  assert.equal(detectLights(cv, image).length, 0);
  assert.deepEqual(sampleLight(image, { x: 30, y: 30 }), { color: 0 });
  const background = new cv.Mat();
  try {
    detectLights(cv, image, background);
    assert.deepEqual(sampleLight(image, { x: 30, y: 30 }, background.data), { color: 0 });
  } finally {
    background.delete();
  }
  assert.equal(sampleLight(image, { x: 3, y: 3 }), null);
});

test("estimates local camera motion from translated background features", async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const width = 640, height = 360;
  const first = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const second = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  let state = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const shade = state >>> 24, offset = (y * width + x) * 4;
      first.data.set([shade, shade, shade, 255], offset);
      if (x + 4 < width && y + 3 < height)
        second.data.set([shade, shade, shade, 255], ((y + 3) * width + x + 4) * 4);
    }
  }
  const estimator = new BackgroundMotion(cv);
  try {
    assert.deepEqual(estimator.observe(first, []), []);
    const flow = estimator.observe(second, []);
    const movement = motionField(flow)({ x: 320, y: 180 });
    assert.ok(movement, "no stable background motion");
    assert.ok(Math.abs(movement.dx - 4) < 0.6, `dx ${movement.dx}`);
    assert.ok(Math.abs(movement.dy - 3) < 0.6, `dy ${movement.dy}`);
  } finally {
    estimator.reset();
  }
});

const recording = new URL("./test_data/mapper3d_test.mp4", import.meta.url);
test("automatically detects the known light in the supplied recording", {
  skip: existsSync(recording) ? false : "Optional test recording is not present",
}, async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const width = 1280, height = 720;
  const data = execFileSync("ffmpeg", ["-v", "error", "-ss", "3", "-i", fileURLToPath(recording),
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: width * height * 4 + 1024 });
  const detections = detectLights(cv, { width, height, data });
  assert.ok(detections.some(point => Math.hypot(point.x - 305, point.y - 337) <= 10));
});

test("automatically decodes a checksum-valid candidate from the supplied recording", {
  skip: existsSync(recording) ? false : "Optional test recording is not present",
  timeout: 120000,
}, async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const width = 640, height = 360, fps = 30, frameSize = width * height * 4;
  const tracker = new MultiLightTracker(), motion = new BackgroundMotion(cv);
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-ss", "3", "-i", fileURLToPath(recording), "-t", "10",
    "-vf", `fps=${fps},scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  let errors = "", buffered = Buffer.alloc(0), frame = 0, decoded = null;
  ffmpeg.stderr.setEncoding("utf8");
  ffmpeg.stderr.on("data", chunk => { errors += chunk; });
  try {
    for await (const chunk of ffmpeg.stdout) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= frameSize && !decoded) {
        const image = { width, height, data: buffered.subarray(0, frameSize) };
        buffered = buffered.subarray(frameSize);
        const flow = motion.observe(image, tracker.tracks), background = new cv.Mat();
        try {
          const detections = detectLights(cv, image, background), pixels = background.data;
          const tracks = tracker.observe(frame * 1000 / fps, detections, {
            motion: motionField(flow),
            sample: point => sampleLight(image, point, pixels),
          });
          decoded = tracks.find(track => track.decoded?.count === 20)?.decoded ?? null;
        } finally {
          background.delete();
        }
        frame++;
      }
      if (decoded) {
        ffmpeg.kill();
        break;
      }
    }
    assert.ok(decoded, `No checksum-valid candidate within ten seconds (${frame} frames). ${errors}`);
  } finally {
    motion.reset();
    if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill();
  }
});

test("tracks and decodes an LED at 60 fps and both 30 fps sampling phases", {
  skip: existsSync(recording) ? false : "Optional test recording is not present",
  timeout: 120000,
}, async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const cases = [
    { name: "60 fps", stride: 1, phase: 0 },
    { name: "30 fps even", stride: 2, phase: 0 },
    { name: "30 fps odd", stride: 2, phase: 1 },
  ].map(item => ({
    ...item, tracker: new LightTracker(cv), decoder: new StreamDecoder(),
    point: { x: 305, y: 337 }, decoded: null,
  }));
  const width = 1280, height = 720, fps = 60;
  const frameSize = width * height * 4;
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-ss", "3", "-i", fileURLToPath(recording), "-t", "10",
    "-vf", `fps=${fps}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  let errors = "";
  ffmpeg.stderr.setEncoding("utf8");
  ffmpeg.stderr.on("data", chunk => { errors += chunk; });
  let buffered = Buffer.alloc(0);
  let frame = 0;
  try {
    for await (const chunk of ffmpeg.stdout) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= frameSize && cases.some(item => !item.decoded)) {
        const pixels = buffered.subarray(0, frameSize);
        buffered = buffered.subarray(frameSize);
        for (const item of cases) {
          if (item.decoded || frame % item.stride !== item.phase) continue;
          const found = item.tracker.observe({ width, height, data: pixels }, item.point);
          if (found) item.point = found;
          item.decoded = item.decoder.add(frame * 1000 / fps, found?.color ?? null);
        }
        frame++;
      }
      if (cases.every(item => item.decoded)) {
        ffmpeg.kill();
        break;
      }
    }
    for (const item of cases) {
      assert.ok(item.decoded, `No valid ${item.name} decode within ten seconds. ${errors}`);
      assert.equal(item.decoded.index, 2);
      assert.equal(item.decoded.count, 20);
    }
  } finally {
    for (const item of cases) item.tracker.reset();
    if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill();
  }
});
