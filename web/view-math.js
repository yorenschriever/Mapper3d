import { jacobiEigen, rotFromVec } from "./sfm.js";

/** Camera centers (-R^T t) of reconstructed cameras. */
export function cameraCenters(cameras) {
  return cameras.map(({ r, t }) => {
    const R = rotFromVec(r);
    return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  });
}

/**
 * Centers the model and rotates it so that the direction of least spread of the lights is "up" (a
 * string lying on a surface becomes level) with the cameras above it. Returns the aligned points,
 * cameras and the radius of the lights around the center.
 */
export function alignModel(lights, centers) {
  const mean = [0, 1, 2].map(d => lights.reduce((s, p) => s + p[d], 0) / lights.length);
  const cov = [0, 1, 2].map(i => [0, 1, 2].map(j => lights.reduce((s, p) => s + (p[i] - mean[i]) * (p[j] - mean[j]), 0) / lights.length));
  const { vectors } = jacobiEigen(cov);
  let [up, a, b] = vectors;
  const height = centers.length ? centers.reduce((s, c) => s + (c[0] - mean[0]) * up[0] + (c[1] - mean[1]) * up[1] + (c[2] - mean[2]) * up[2], 0) / centers.length : 1;
  if (height < 0) up = up.map(v => -v);
  b = [up[1] * a[2] - up[2] * a[1], up[2] * a[0] - up[0] * a[2], up[0] * a[1] - up[1] * a[0]];
  const to = p => { const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]]; return [a, b, up].map(axis => axis[0] * d[0] + axis[1] * d[1] + axis[2] * d[2]); };
  const aligned = lights.map(to);
  return { lights: aligned, centers: centers.map(to), radius: Math.max(1e-9, ...aligned.map(p => Math.hypot(...p))) };
}

/** Orbit projection: x right, y forward, z up in model space; returns screen position, depth and size factor. */
export function project3d(p, { yaw, pitch, scale, cx, cy }) {
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const x = p[0] * cosY - p[1] * sinY, y = p[0] * sinY + p[1] * cosY, z = p[2];
  const depth = y * cosP - z * sinP, up = z * cosP + y * sinP;
  return { x: cx + x * scale, y: cy - up * scale, depth, perspective: 1 };
}
