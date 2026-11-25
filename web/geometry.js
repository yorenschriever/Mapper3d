function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a, b) {
  return a.map((value, i) => value - b[i]);
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map(value => value / length);
}

function rotate(pose, vector) {
  return [
    pose[0] * vector[0] + pose[1] * vector[1] + pose[2] * vector[2],
    pose[4] * vector[0] + pose[5] * vector[1] + pose[6] * vector[2],
    pose[8] * vector[0] + pose[9] * vector[1] + pose[10] * vector[2],
  ];
}

function inverseRotate(pose, vector) {
  return [
    pose[0] * vector[0] + pose[4] * vector[1] + pose[8] * vector[2],
    pose[1] * vector[0] + pose[5] * vector[1] + pose[9] * vector[2],
    pose[2] * vector[0] + pose[6] * vector[1] + pose[10] * vector[2],
  ];
}

export function argusFovParameter(width, height, horizontalFov) {
  const desired = width / (2 * Math.tan(horizontalFov * Math.PI / 360));
  const aspect = width / height;
  const factorH = width > height ? aspect : 1;
  const factorV = width > height ? 1 : aspect;
  let low = 1, high = 179 / Math.max(factorH, factorV);
  for (let i = 0; i < 50; i++) {
    const middle = (low + high) / 2;
    const fx = width / (2 * Math.tan(middle * factorH * Math.PI / 360));
    const fy = height / (2 * Math.tan(middle * factorV * Math.PI / 360));
    if (Math.min(fx, fy) > desired) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function cameraRay(pose, reference, intrinsics, x, y) {
  // ArgusAR's Sophus pose export stores rotation rows and then translation.
  const center = [pose[12], pose[13], pose[14]];
  const referenceCenter = [reference[12], reference[13], reference[14]];
  const cameraDirection = normalize([(x - intrinsics.cx) / intrinsics.fx, (y - intrinsics.cy) / intrinsics.fy, 1]);
  return {
    origin: inverseRotate(reference, subtract(center, referenceCenter)),
    direction: normalize(inverseRotate(reference, rotate(pose, cameraDirection))),
  };
}

function leastSquares(rays) {
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const { origin, direction } of rays) {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const value = (row === col ? 1 : 0) - direction[row] * direction[col];
        matrix[row][col] += value;
        matrix[row][3] += value * origin[col];
      }
    }
  }
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-8) return null;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    for (let j = col; j < 4; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let j = col; j < 4; j++) matrix[row][j] -= factor * matrix[col][j];
    }
  }
  return matrix.map(row => row[3]);
}

function angularError(ray, point) {
  const offset = subtract(point, ray.origin);
  if (dot(offset, ray.direction) <= 0) return Infinity;
  return Math.acos(Math.max(-1, Math.min(1, dot(normalize(offset), ray.direction))));
}

export function triangulate(rays) {
  if (rays.length < 3) return null;
  const selected = rays.length <= 30 ? rays : Array.from({ length: 30 }, (_, i) =>
    rays[Math.floor(i * (rays.length - 1) / 29)]);
  let best = [];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      if (dot(selected[i].direction, selected[j].direction) > Math.cos(3 * Math.PI / 180)) continue;
      if (Math.hypot(...subtract(selected[i].origin, selected[j].origin)) < 1e-4) continue;
      const point = leastSquares([selected[i], selected[j]]);
      if (!point) continue;
      const inliers = rays.filter(ray => angularError(ray, point) < 0.015);
      if (inliers.length > best.length) best = inliers;
    }
  }
  if (best.length < 3 || best.length < rays.length * 0.6) return null;
  const point = leastSquares(best);
  if (!point || best.some(ray => angularError(ray, point) >= 0.02)) return null;
  const rms = Math.sqrt(best.reduce((sum, ray) => sum + angularError(ray, point) ** 2, 0) / best.length);
  return { point, inliers: best.length, observations: rays.length, rmsRadians: rms };
}
