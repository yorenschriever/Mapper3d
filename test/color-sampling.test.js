import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFeatures, colorSamplingScale } from "../web/stationary.js";
import { nodePool } from "../scripts/node-pool.js";

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
    assert.equal((await pool.analyze({ width, height, data: data.slice() })).length, 500);
    assert.equal((await pool.analyze({ width, height, data: data.slice() }, { maxSpots: 200 })).length, 200);
  } finally {
    pool.terminate();
  }
});
