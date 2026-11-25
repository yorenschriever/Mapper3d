import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import cv from "@techstark/opencv-js";
import { LightTracker, locateLight } from "../web/led-tracker.js";
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

const recording = new URL("./test_data/mapper3d_test.mp4", import.meta.url);
test("tracks and decodes an LED from the supplied recording", {
  skip: existsSync(recording) ? false : "Optional test recording is not present",
  timeout: 120000,
}, async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const tracker = new LightTracker(cv);
  const decoder = new StreamDecoder();
  const width = 1280, height = 720, fps = 60;
  const frameSize = width * height * 4;
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-ss", "3", "-i", fileURLToPath(recording), "-t", "10",
    "-vf", `fps=${fps}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  let errors = "";
  ffmpeg.stderr.setEncoding("utf8");
  ffmpeg.stderr.on("data", chunk => { errors += chunk; });
  let buffered = Buffer.alloc(0);
  let frame = 0;
  let point = { x: 305, y: 337 };
  let decoded = null;
  try {
    for await (const chunk of ffmpeg.stdout) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= frameSize && !decoded) {
        const pixels = buffered.subarray(0, frameSize);
        buffered = buffered.subarray(frameSize);
        const found = tracker.observe({ width, height, data: pixels }, point);
        if (found) point = found;
        decoded = decoder.add(frame * 1000 / fps, found?.color ?? null);
        frame++;
      }
      if (decoded) {
        ffmpeg.kill();
        break;
      }
    }
    assert.ok(decoded, `No valid decode within ten seconds. ${errors}`);
    assert.equal(decoded.index, 2);
    assert.equal(decoded.count, 20);
  } finally {
    tracker.reset();
    if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill();
  }
});
