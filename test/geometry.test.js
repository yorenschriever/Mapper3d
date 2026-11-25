import { test } from "node:test";
import assert from "node:assert/strict";
import { argusFovParameter, cameraRay, triangulate } from "../web/geometry.js";

const intrinsics = { fx: 500, fy: 500, cx: 320, cy: 240 };
const pose = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

test("maps horizontal field of view to Argus intrinsics in either orientation", () => {
  for (const [width, height] of [[640, 360], [360, 640], [640, 640]]) {
    const fov = argusFovParameter(width, height, 65);
    const aspect = width / height;
    const horizontal = fov * (width > height ? aspect : 1);
    const vertical = fov * (width > height ? 1 : aspect);
    const focal = Math.min(width / (2 * Math.tan(horizontal * Math.PI / 360)),
      height / (2 * Math.tan(vertical * Math.PI / 360)));
    assert.ok(Math.abs(focal - width / (2 * Math.tan(65 * Math.PI / 360))) < 1e-8);
  }
});

test("triangulates a point in the first camera's coordinate system", () => {
  const reference = pose(10, 4, 1);
  const point = [10.3, 4.2, 5];
  const rays = [0, 0.3, 0.7, 1].map(offset => {
    const camera = pose(10 + offset, 4, 1);
    const x = intrinsics.cx + intrinsics.fx * (point[0] - camera[12]) / (point[2] - camera[14]);
    const y = intrinsics.cy + intrinsics.fy * (point[1] - camera[13]) / (point[2] - camera[14]);
    return cameraRay(camera, reference, intrinsics, x, y);
  });
  const estimate = triangulate(rays);
  assert.ok(estimate);
  for (const [actual, expected] of estimate.point.map((value, i) => [value, [0.3, 0.2, 4][i]]))
    assert.ok(Math.abs(actual - expected) < 1e-8);
});

test("uses camera rotation and rejects a bad observation", () => {
  const reference = pose(0, 0, 0);
  const rotated = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];
  const rotatedRay = cameraRay(rotated, reference, intrinsics, 320, 240);
  assert.deepEqual(rotatedRay.direction, [1, 0, 0]);
  const relativeRay = cameraRay(rotated, rotated, intrinsics, 320, 240);
  assert.deepEqual(relativeRay.direction, [0, 0, 1]);
  const rays = [-1, -0.5, 0, 0.5, 1].map(x =>
    cameraRay(pose(x, 0, 0), reference, intrinsics, 320 - x * 100, 240));
  rays.push(cameraRay(pose(0, 1, 0), reference, intrinsics, 600, 400));
  const estimate = triangulate(rays);
  assert.ok(estimate);
  assert.equal(estimate.inliers, 5);
  assert.ok(Math.abs(estimate.point[2] - 5) < 1e-8);
});

test("does not produce positions without adequate parallax or in front of both cameras", () => {
  const reference = pose(0, 0, 0);
  const identical = Array.from({ length: 3 }, () => cameraRay(reference, reference, intrinsics, 320, 240));
  assert.equal(triangulate(identical), null);
  const behind = [-1, 0, 1].map(x =>
    cameraRay(pose(x, 0, 0), reference, intrinsics, 320 + x * 100, 240));
  assert.equal(triangulate(behind), null);
});
