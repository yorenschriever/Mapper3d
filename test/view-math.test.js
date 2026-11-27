import { test } from "node:test";
import assert from "node:assert/strict";
import { alignModel, cameraCenters, firstCameraView, projectCamera } from "../web/view-math.js";
import { rotFromVec } from "../web/sfm.js";

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

test("the first camera view preserves its original image orientation and projection", () => {
  const camera = { r: [0.2, -0.3, 0.4], t: [0.1, -0.2, 4] };
  const lights = [[-1, 0, 0], [1, 0, 0], [0, -1, 0.5], [0, 1, -0.5]];
  const aligned = alignModel(lights, cameraCenters([camera]));
  const view = firstCameraView(camera, aligned.centers[0], aligned.axes);
  const R = rotFromVec(camera.r), focal = 500, cx = 320, cy = 240;
  for (let i = 0; i < lights.length; i++) {
    const p = lights[i];
    const cameraPoint = [0, 1, 2].map(row => R.slice(row * 3, row * 3 + 3).reduce((s, v, j) => s + v * p[j], camera.t[row]));
    const projected = projectCamera(aligned.lights[i], view, { focal, cx, cy });
    assert.ok(Math.abs(projected.x - (cx + focal * cameraPoint[0] / cameraPoint[2])) < 1e-8);
    assert.ok(Math.abs(projected.y - (cy + focal * cameraPoint[1] / cameraPoint[2])) < 1e-8);
  }
});

test("camera projection does not display points behind the camera", () => {
  const view = firstCameraView({ r: [0, 0, 0] }, [0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.equal(projectCamera([0, 0, -1], view, { focal: 500, cx: 0, cy: 0 }), null);
});
