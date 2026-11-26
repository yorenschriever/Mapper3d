/*
 * Structure from motion with known correspondences: every observation is a 2D position of an LED
 * with a decoded index, so there is no feature matching. Cameras are {r: rotation vector, t}
 * with x_cam = R X + t, projection u = f * x / z + cx, v = f * y / z + cy.
 */

// ---- small linear algebra ----

export function rotFromVec([x, y, z]) {
  const theta = Math.hypot(x, y, z);
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const kx = x / theta, ky = y / theta, kz = z / theta, c = Math.cos(theta), s = Math.sin(theta), v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

export function vecFromRot(R) {
  const cos = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)), theta = Math.acos(cos);
  if (theta < 1e-9) return [0, 0, 0];
  if (Math.PI - theta < 1e-4) {
    const xx = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), yy = Math.sqrt(Math.max(0, (R[4] + 1) / 2)), zz = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    const x = xx, y = R[1] + R[3] >= 0 ? yy : -yy, z = R[2] + R[6] >= 0 ? zz : -zz;
    return [x * theta, y * theta, z * theta];
  }
  const k = theta / (2 * Math.sin(theta));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

const mul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
};
const transpose3 = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const det3 = A => A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
const apply3 = (R, v) => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];

/** Eigen decomposition of a symmetric matrix (array of rows) by Jacobi rotations; ascending eigenvalues. */
export function jacobiEigen(matrix) {
  const n = matrix.length, A = matrix.map(r => [...r]), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
        for (let k = 0; k < n; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
        for (let k = 0; k < n; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
      }
    }
  }
  const order = [...Array(n).keys()].sort((a, b) => A[a][a] - A[b][b]);
  return { values: order.map(i => A[i][i]), vectors: order.map(i => V.map(row => row[i])) };
}

/** Solves A x = b for a dense matrix by Gaussian elimination with partial pivoting; A is an array of rows. */
export function solveLinear(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

function invert(A) {
  const n = A.length, columns = [];
  for (let j = 0; j < n; j++) columns.push(solveLinear(A, Array.from({ length: n }, (_, i) => +(i === j))));
  return Array.from({ length: n }, (_, i) => columns.map(col => col[i]));
}

// ---- projection ----

function projectWith(R, t, focal, cx, cy, X) {
  const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  return { u: focal * x / z + cx, v: focal * y / z + cy, z };
}

export function reprojection(camera, focal, cx, cy, point, observation) {
  const p = projectWith(rotFromVec(camera.r), camera.t, focal, cx, cy, point);
  if (!(p.z > 1e-9)) return { error: Infinity, z: p.z };
  return { error: Math.hypot(p.u - observation.x, p.v - observation.y), z: p.z };
}

// ---- two-view geometry ----

const normalize = (o, f, cx, cy) => ({ x: (o.x - cx) / f, y: (o.y - cy) / f });

function essentialFrom(pairs) {
  const AtA = Array.from({ length: 9 }, () => new Array(9).fill(0));
  for (const [a, b] of pairs) {
    const row = [b.x * a.x, b.x * a.y, b.x, b.y * a.x, b.y * a.y, b.y, a.x, a.y, 1];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) AtA[i][j] += row[i] * row[j];
  }
  const E = jacobiEigen(AtA).vectors[0];
  return svd3(E);
}

function svd3(E) {
  const EtE = [0, 1, 2].map(i => [0, 1, 2].map(j => E[i] * E[j] + E[3 + i] * E[3 + j] + E[6 + i] * E[6 + j]));
  const { values, vectors } = jacobiEigen(EtE);
  const order = [2, 1, 0], V = order.map(i => vectors[i]), sigma = order.map(i => Math.sqrt(Math.max(0, values[i])));
  const U = V.map((v, i) => {
    const col = apply3(E, v);
    return col.map(x => x / (sigma[i] || 1));
  });
  U[2] = [U[0][1] * U[1][2] - U[0][2] * U[1][1], U[0][2] * U[1][0] - U[0][0] * U[1][2], U[0][0] * U[1][1] - U[0][1] * U[1][0]];
  return { U, V, sigma };
}

function sampson(Em, a, b) {
  const Ex = apply3(Em, [a.x, a.y, 1]), Etx = apply3(transpose3(Em), [b.x, b.y, 1]);
  const num = b.x * Ex[0] + b.y * Ex[1] + Ex[2];
  const den = Ex[0] ** 2 + Ex[1] ** 2 + Etx[0] ** 2 + Etx[1] ** 2;
  return Math.abs(num) / Math.sqrt(den || 1e-12);
}

/** Triangulates one point from several views; views: [{R, t, x, y}] in normalized coordinates. */
export function triangulate(views) {
  const AtA = Array.from({ length: 4 }, () => new Array(4).fill(0));
  for (const { R, t, x, y } of views) {
    const P = [[R[0], R[1], R[2], t[0]], [R[3], R[4], R[5], t[1]], [R[6], R[7], R[8], t[2]]];
    for (const row of [P[0].map((v, k) => x * P[2][k] - v), P[1].map((v, k) => y * P[2][k] - v)]) {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) AtA[i][j] += row[i] * row[j];
    }
  }
  const v = jacobiEigen(AtA).vectors[0];
  return v[3] ? [v[0] / v[3], v[1] / v[3], v[2] / v[3]] : null;
}

/**
 * Relative pose of two views from shared points by RANSAC 8-point.
 * pairs: [{id, a: {x, y}, b: {x, y}}] in pixels. Returns {R, t, ids} (camera a is the identity) or null.
 */
export function initialPose(pairs, focal, cx, cy, { iterations = 400, threshold = 3, random = Math.random } = {}) {
  if (pairs.length < 9) return null;
  const n = pairs.map(p => [normalize(p.a, focal, cx, cy), normalize(p.b, focal, cx, cy)]);
  let best = null;
  for (let it = 0; it < iterations; it++) {
    const pick = new Set();
    while (pick.size < 8) pick.add(Math.floor(random() * n.length));
    const { U, V } = essentialFrom([...pick].map(i => n[i]));
    const Ue = [0, 1, 2].map(r => [0, 1, 2].map(c => U[c][r])).flat();
    const Ve = [0, 1, 2].map(r => [0, 1, 2].map(c => V[c][r])).flat();
    const Em = mul3(mul3(Ue, [1, 0, 0, 0, 1, 0, 0, 0, 0]), transpose3(Ve));
    const inliers = [];
    n.forEach((pair, i) => { if (sampson(Em, pair[0], pair[1]) * focal < threshold) inliers.push(i); });
    if (!best || inliers.length > best.inliers.length) best = { inliers, U, V };
  }
  if (!best || best.inliers.length < 8) return null;
  const { U, V } = essentialFrom(best.inliers.map(i => n[i]));
  const Um = [0, 1, 2].map(r => [0, 1, 2].map(c => U[c][r])).flat();
  const Vm = [0, 1, 2].map(r => [0, 1, 2].map(c => V[c][r])).flat();
  const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const candidates = [];
  for (const Wm of [W, transpose3(W)]) {
    let R = mul3(mul3(Um, Wm), transpose3(Vm));
    if (det3(R) < 0) R = R.map(v => -v);
    for (const sign of [1, -1]) candidates.push({ R, t: [U[2][0] * sign, U[2][1] * sign, U[2][2] * sign] });
  }
  let chosen = null;
  for (const candidate of candidates) {
    let front = 0;
    for (const i of best.inliers) {
      const X = triangulate([{ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], ...n[i][0] }, { R: candidate.R, t: candidate.t, ...n[i][1] }]);
      if (!X) continue;
      const z2 = apply3(candidate.R, X)[2] + candidate.t[2];
      if (X[2] > 0 && z2 > 0) front++;
    }
    if (!chosen || front > chosen.front) chosen = { ...candidate, front };
  }
  return { R: chosen.R, t: chosen.t, ids: best.inliers.map(i => pairs[i].id), front: chosen.front };
}

// ---- optimization ----

const huber = (e, delta) => (e <= delta ? e * e : 2 * delta * e - delta * delta);

/** Refines one camera (6 parameters) against fixed points. observations: [{point: [x,y,z], x, y}]. */
export function refineCamera(camera, focal, cx, cy, observations, { iterations = 30, delta = 4 } = {}) {
  let params = [...camera.r, ...camera.t];
  const cost = p => {
    const R = rotFromVec(p.slice(0, 3));
    let c = 0;
    for (const o of observations) {
      const q = projectWith(R, p.slice(3), focal, cx, cy, o.point);
      c += q.z > 1e-9 ? huber(Math.hypot(q.u - o.x, q.v - o.y), delta) : 1e6;
    }
    return c;
  };
  let current = cost(params), lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const H = Array.from({ length: 6 }, () => new Array(6).fill(0)), g = new Array(6).fill(0);
    const R = rotFromVec(params.slice(0, 3));
    for (const o of observations) {
      const base = projectWith(R, params.slice(3), focal, cx, cy, o.point);
      if (!(base.z > 1e-9)) continue;
      const rx = base.u - o.x, ry = base.v - o.y, norm = Math.hypot(rx, ry), w = norm <= delta ? 1 : delta / norm;
      const J = [new Array(6), new Array(6)];
      for (let k = 0; k < 6; k++) {
        const p = [...params], h = 1e-6;
        p[k] += h;
        const q = projectWith(rotFromVec(p.slice(0, 3)), p.slice(3), focal, cx, cy, o.point);
        J[0][k] = (q.u - base.u) / h; J[1][k] = (q.v - base.v) / h;
      }
      for (let i = 0; i < 6; i++) {
        g[i] += w * (J[0][i] * rx + J[1][i] * ry);
        for (let j = 0; j < 6; j++) H[i][j] += w * (J[0][i] * J[0][j] + J[1][i] * J[1][j]);
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const A = H.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (H[i][i] + 1e-6) : 0)));
      const step = solveLinear(A, g.map(v => -v));
      const trial = params.map((v, i) => v + step[i]), c = cost(trial);
      if (c < current) { params = trial; current = c; lambda = Math.max(1e-9, lambda / 3); improved = true; } else lambda *= 4;
    }
    if (!improved) break;
  }
  return { r: params.slice(0, 3), t: params.slice(3) };
}

/**
 * Robust bundle adjustment: cameras and points (and optionally the shared focal length) are refined
 * together. Cameras are eliminated block-wise, so it scales with the number of cameras; the dense
 * system over points is small for strings of a few hundred lights.
 * observations: [{c, p, x, y}]. Camera 0 is held fixed. Mutates cameras/points; returns {focal, rms}.
 */
export function bundleAdjust(cameras, points, observations, focal, cx, cy, { iterations = 25, refineFocal = false, delta = 4 } = {}) {
  const C = cameras.length, P = points.length, G = 3 * P + 1;
  const used = new Set(observations.map(o => o.p));
  const evaluate = (cams, pts, f) => {
    let cost = 0, sq = 0, n = 0;
    const Rs = cams.map(c => rotFromVec(c.r));
    for (const o of observations) {
      const q = projectWith(Rs[o.c], cams[o.c].t, f, cx, cy, pts[o.p]);
      const e = q.z > 1e-9 ? Math.hypot(q.u - o.x, q.v - o.y) : 1e3;
      cost += huber(e, delta); sq += e * e; n++;
    }
    return { cost, rms: Math.sqrt(sq / Math.max(1, n)) };
  };
  let current = evaluate(cameras, points, focal), lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const Hcc = Array.from({ length: C }, () => Array.from({ length: 6 }, () => new Array(6).fill(0)));
    const bc = Array.from({ length: C }, () => new Array(6).fill(0));
    const Hcg = Array.from({ length: C }, () => Array.from({ length: 6 }, () => new Float64Array(G)));
    const Hgg = Array.from({ length: G }, () => new Float64Array(G)), bg = new Float64Array(G);
    const Rs = cameras.map(c => rotFromVec(c.r));
    for (const o of observations) {
      const cam = cameras[o.c], X = points[o.p], R = Rs[o.c];
      const base = projectWith(R, cam.t, focal, cx, cy, X);
      if (!(base.z > 1e-9)) continue;
      const rx = base.u - o.x, ry = base.v - o.y, norm = Math.hypot(rx, ry), w = norm <= delta ? 1 : delta / norm;
      const Jc = [new Array(6).fill(0), new Array(6).fill(0)], Jg = [new Array(4).fill(0), new Array(4).fill(0)];
      const h = 1e-6;
      if (o.c !== 0) {
        for (let k = 0; k < 6; k++) {
          const r = [...cam.r], t = [...cam.t];
          if (k < 3) r[k] += h; else t[k - 3] += h;
          const q = projectWith(rotFromVec(r), t, focal, cx, cy, X);
          Jc[0][k] = (q.u - base.u) / h; Jc[1][k] = (q.v - base.v) / h;
        }
      }
      for (let k = 0; k < 3; k++) {
        const Y = [...X]; Y[k] += h;
        const q = projectWith(R, cam.t, focal, cx, cy, Y);
        Jg[0][k] = (q.u - base.u) / h; Jg[1][k] = (q.v - base.v) / h;
      }
      if (refineFocal) {
        const q = projectWith(R, cam.t, focal + 1e-3, cx, cy, X);
        Jg[0][3] = (q.u - base.u) / 1e-3; Jg[1][3] = (q.v - base.v) / 1e-3;
      }
      const cols = [3 * o.p, 3 * o.p + 1, 3 * o.p + 2, 3 * P];
      const r2 = [rx, ry];
      for (let i = 0; i < 6; i++) {
        for (let d = 0; d < 2; d++) bc[o.c][i] += w * Jc[d][i] * r2[d];
        for (let j = 0; j < 6; j++) for (let d = 0; d < 2; d++) Hcc[o.c][i][j] += w * Jc[d][i] * Jc[d][j];
        for (let j = 0; j < 4; j++) for (let d = 0; d < 2; d++) Hcg[o.c][i][cols[j]] += w * Jc[d][i] * Jg[d][j];
      }
      for (let i = 0; i < 4; i++) {
        for (let d = 0; d < 2; d++) bg[cols[i]] += w * Jg[d][i] * r2[d];
        for (let j = 0; j < 4; j++) for (let d = 0; d < 2; d++) Hgg[cols[i]][cols[j]] += w * Jg[d][i] * Jg[d][j];
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const S = Hgg.map((row, i) => Array.from(row, (v, j) => v + (i === j ? lambda * (Hgg[i][i] + 1e-6) + (i >= 3 * P && !refineFocal ? 1 : 0) + (i < 3 * P && !used.has(Math.floor(i / 3)) ? 1 : 0) : 0)));
      const rhs = Array.from(bg, v => -v);
      const inverses = new Array(C);
      for (let c = 1; c < C; c++) {
        const A = Hcc[c].map((row, i) => row.map((v, j) => v + (i === j ? lambda * (Hcc[c][i][i] + 1e-6) + 1e-9 : 0)));
        if (!bc[c].some(v => v) && !Hcc[c].some(row => row.some(v => v))) continue;
        const inv = invert(A);
        inverses[c] = inv;
        const M = inv.map(row => {
          const out = new Float64Array(G);
          row.forEach((v, k) => { const src = Hcg[c][k]; for (let g = 0; g < G; g++) out[g] += v * src[g]; });
          return out;
        });
        for (let i = 0; i < 6; i++) {
          const left = Hcg[c][i];
          let dotb = 0;
          for (let k = 0; k < 6; k++) dotb += inv[i][k] * bc[c][k];
          for (let g = 0; g < G; g++) {
            if (left[g] === 0) continue;
            rhs[g] += left[g] * dotb;
            for (let j = 0; j < G; j++) S[g][j] -= left[g] * M[i][j];
          }
        }
      }
      const dg = solveLinear(S, rhs);
      const cams = cameras.map((cam, c) => {
        if (!inverses[c]) return cam;
        const t = bc[c].map((v, i) => -v - Hcg[c][i].reduce((s, h, g) => s + h * dg[g], 0));
        const step = inverses[c].map(row => row.reduce((s, v, k) => s + v * t[k], 0));
        return { r: cam.r.map((v, i) => v + step[i]), t: cam.t.map((v, i) => v + step[3 + i]) };
      });
      const pts = points.map((X, p) => X.map((v, k) => v + dg[3 * p + k]));
      const f = refineFocal ? focal + dg[3 * P] : focal;
      const trial = evaluate(cams, pts, f);
      if (trial.cost < current.cost && f > 100) {
        cams.forEach((cam, c) => { cameras[c] = cam; });
        pts.forEach((X, p) => { points[p] = X; });
        focal = f; current = trial; lambda = Math.max(1e-9, lambda / 3); improved = true;
      } else lambda *= 4;
    }
    if (!improved) break;
  }
  return { focal, rms: current.rms };
}
