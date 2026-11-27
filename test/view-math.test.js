import { test } from "node:test";
import assert from "node:assert/strict";
import { alignModel, cameraCenters, project3d } from "../web/view-math.js";

test("aligning a tilted flat string makes it level with the cameras above", () => {
  const lights = [];
  for (let i = 0; i < 30; i++) {
    const a = Math.cos(i), b = Math.sin(i * 1.7) * 2;
    lights.push([a + 3, b + 0.5 * a, 0.7 * a - 0.3 * b + 2]); // plane z = 0.7x - 0.3y + const
  }
  const centers = [[3, 0, 40], [3, 1, 60]];
  const aligned = alignModel(lights, centers);
  const heights = aligned.lights.map(p => p[2]);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 0.05);
  assert.ok(aligned.centers.every(c => c[2] > 1));
});

test("camera centers invert the pose", () => {
  const [c] = cameraCenters([{ r: [0, 0, Math.PI / 2], t: [1, 2, 3] }]);
  assert.deepEqual(c.map(v => +v.toFixed(6)), [-2, 1, -3]);
});

test("positive pitch views a level model from above with the correct handedness", () => {
  const options = { yaw: 0, pitch: Math.PI / 4, scale: 1, cx: 0, cy: 0 };
  const origin = project3d([0, 0, 0], options);
  const right = project3d([1, 0, 0], options);
  const forward = project3d([0, 1, 0], options);
  const above = project3d([0, 0, 1], options);
  assert.ok(right.x > origin.x);
  assert.ok(forward.y < origin.y);
  assert.ok(above.y < origin.y);
  assert.ok(above.depth < origin.depth);
});
