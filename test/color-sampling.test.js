import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFeatures, colorSamplingScale } from "../web/stationary.js";
import { MAX_SPOTS_PER_FRAME, SPOT_SEPARATION } from "../web/config.js";
import { nodePool } from "../scripts/node-pool.js";
import { analyzeFrame } from "../web/analyze.js";

function light(coreRadius, point = { x: 64, y: 64 }) {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const distance = Math.hypot(x - point.x, y - point.y);
    const color = distance <= coreRadius ? [255, 255, 255] : distance <= 2 * coreRadius ? [190, 40, 20] : [8, 8, 8];
    data.set([...color, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test("samples colored glow around both small and large clipped LED cores", () => {
  const point = { x: 64, y: 64 };
  const small = light(4), large = light(12);
  const smallScale = colorSamplingScale(small, point), largeScale = colorSamplingScale(large, point);
  assert.ok(largeScale > smallScale);
  for (const [image, scale] of [[small, smallScale], [large, largeScale]]) {
    const features = colorFeatures(image, point, scale);
    assert.ok(features.slice(4, 10).some((value, i) => i % 3 === 0 && value > 0.9), "red glow is represented");
  }
  assert.ok(colorFeatures(large, point, 1)[4] < 0.1, "fixed inner ring misses the large glow");
});

test("samples lights near image boundaries without invalid features", () => {
  const point = { x: 5, y: 12 }, image = light(8, point);
  const features = colorFeatures(image, point);
  assert.equal(features.length, 10);
  assert.ok(features.every(Number.isFinite));
  assert.ok(features[4] > 0.8 || features[7] > 0.8);
});

test("adapts to an unclipped colored light without mistaking a nearby light for its size", () => {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4);
  const point = { x: 48, y: 64 };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const distance = Math.hypot(x - point.x, y - point.y);
    const neighbor = Math.hypot(x - 69, y - 64);
    const color = neighbor <= 3 ? [255, 255, 255] : distance <= 8 ? [220, 25, 15] : distance <= 16 ? [130, 30, 20] : [8, 8, 8];
    data.set([...color, 255], (y * width + x) * 4);
  }
  const image = { width, height, data }, scale = colorSamplingScale(image, point);
  assert.ok(scale > 1 && scale < 3);
  const features = colorFeatures(image, point, scale);
  assert.ok(features[0] > 0.9 && features[4] > 0.9);
});

test("worker analysis uses the configured spot limit and supports an explicit override", async () => {
  const width = 600, height = 460, data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < 20; row++) for (let col = 0; col < 26; col++) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      data.set([255, 50, 10, 255], ((20 + row * 22 + y) * width + 20 + col * 22 + x) * 4);
    }
  }
  const pool = nodePool(1);
  try {
    const all = await pool.analyze({ width, height, data: data.slice() }, { maxSpots: 600 });
    assert.equal((await pool.analyze({ width, height, data: data.slice() })).length, Math.min(all.length, MAX_SPOTS_PER_FRAME));
    assert.equal((await pool.analyze({ width, height, data: data.slice() }, { maxSpots: 200 })).length, 200);
  } finally {
    pool.terminate();
  }
});

test("worker analysis uses the configured spot separation and supports an explicit override", async () => {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4);
  for (const cx of [50, 60]) for (let y = 61; y <= 67; y++) for (let x = cx - 3; x <= cx + 3; x++) {
    data.set([255, 50, 10, 255], (y * width + x) * 4);
  }
  const pool = nodePool(1);
  try {
    assert.equal((await pool.analyze({ width, height, data: data.slice() }, { maxSpots: 2 })).length,
      SPOT_SEPARATION > 5 ? 1 : 2);
    assert.equal((await pool.analyze({ width, height, data: data.slice() }, { maxSpots: 2, separation: 4 })).length, 2);
    assert.equal((await pool.analyze({ width, height, data: data.slice() }, { maxSpots: 2, separation: 7 })).length, 1);
  } finally {
    pool.terminate();
  }
});

test("nearby lights retain separate positions and colors", () => {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4);
  for (const [cx, color] of [[50, [255, 40, 10]], [60, [10, 40, 255]]]) {
    for (let y = 61; y <= 67; y++) for (let x = cx - 3; x <= cx + 3; x++) {
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  const spots = analyzeFrame({ width, height, data }, { separation: 4 }).sort((a, b) => a.x - b.x);
  assert.equal(spots.length, 2);
  assert.ok(Math.abs(spots[0].x - 50) < 2 && Math.abs(spots[1].x - 60) < 2);
  assert.ok(spots[0].features[0] > 0.9 && spots[0].features[2] < 0.2);
  assert.ok(spots[1].features[2] > 0.9 && spots[1].features[0] < 0.2);
});
