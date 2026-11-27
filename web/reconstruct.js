import { bundleAdjust, initialPose, reprojection, refineCamera, rotFromVec, triangulate, vecFromRot } from "./sfm.js";

function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Groups decoded tracklets into frames: frames[k] = {time, observations: Map(index -> [{x, y, margin}])}.
 * Only every `step`-th video frame is kept. Several candidates per index appear when tracklets overlap.
 */
export function framesFromTracks(tracks, step = 4) {
  const times = [...new Set(tracks.flatMap(t => t.samples.map(s => s.time)))].sort((a, b) => a - b);
  const keep = new Set(times.filter((_, i) => i % step === 0));
  const frames = new Map();
  for (const track of tracks) {
    for (const s of track.samples) {
      if (!keep.has(s.time)) continue;
      if (!frames.has(s.time)) frames.set(s.time, { time: s.time, observations: new Map() });
      const list = frames.get(s.time).observations;
      if (!list.has(track.index)) list.set(track.index, []);
      list.get(track.index).push({ x: s.x, y: s.y, margin: track.margin });
    }
  }
  return [...frames.values()].sort((a, b) => a.time - b.time);
}

/**
 * Reconstructs camera poses and the 3D positions of the lights from decoded observations.
 * Returns { points: Map(index -> [x, y, z]), cameras: [{frame, time, r, t}], focal, rms, observations }.
 * The scale is arbitrary and the focal length (pixels) is estimated; `focal` is only the starting guess.
 */
export function reconstruct(frames, { width, height, focal = 0.66 * width, log = () => {}, onProgress = () => {}, onStage = () => {}, random = seededRandom(1) } = {}) {
  const cx = width / 2, cy = height / 2;
  const chosen = frames.map(f => new Map([...f.observations].map(([id, list]) => [id, list.reduce((a, b) => (b.margin > a.margin ? b : a))])));

  onStage("Finding a starting viewpoint");
  // Initial pair: many shared lights, a visible disparity, and a pose that explains the points well.
  // Pure rotation and flat scenes give inconsistent poses, which the reprojection check rejects.
  // If nothing passes the strict limits, retry with progressively looser ones.
  const levels = [
    { minShared: 10, minDisparity: 20, minWide: 8, maxRms: 3 },
    { minShared: 8, minDisparity: 10, minWide: 6, maxRms: 4 },
    { minShared: 6, minDisparity: 5, minWide: 5, maxRms: 6 },
  ];
  let pair = null, relative = null, mostShared = 0, mostDisparity = 0;
  for (const level of levels) {
    if (pair) break;
    for (let a = 0; a < frames.length; a += 2) {
    for (const gap of [6, 12, 24, 40, 60, 90, 130, 200]) {
      const b = a + gap;
      if (b >= frames.length) continue;
      const shared = [...chosen[a].keys()].filter(id => chosen[b].has(id));
      mostShared = Math.max(mostShared, shared.length);
      if (shared.length < level.minShared) continue;
      const disparity = shared.map(id => Math.hypot(chosen[a].get(id).x - chosen[b].get(id).x, chosen[a].get(id).y - chosen[b].get(id).y)).sort((x, y) => x - y)[shared.length >> 1];
      mostDisparity = Math.max(mostDisparity, disparity);
      if (disparity < level.minDisparity) continue;
      const pose = initialPose(shared.map(id => ({ id, a: chosen[a].get(id), b: chosen[b].get(id) })), focal, cx, cy, { random, iterations: 150 });
      if (!pose || pose.ids.length < level.minWide) continue;
      const camera = { r: vecFromRot(pose.R), t: pose.t }, origin = { r: [0, 0, 0], t: [0, 0, 0] };
      const center = [-(pose.R[0] * pose.t[0] + pose.R[3] * pose.t[1] + pose.R[6] * pose.t[2]), -(pose.R[1] * pose.t[0] + pose.R[4] * pose.t[1] + pose.R[7] * pose.t[2]), -(pose.R[2] * pose.t[0] + pose.R[5] * pose.t[1] + pose.R[8] * pose.t[2])];
      let sq = 0, ok = 0, wide = 0;
      for (const id of pose.ids) {
        const oa = chosen[a].get(id), ob = chosen[b].get(id);
        const n = o => ({ x: (o.x - cx) / focal, y: (o.y - cy) / focal });
        const X = triangulate([{ R: IDENTITY, t: [0, 0, 0], ...n(oa) }, { R: pose.R, t: pose.t, ...n(ob) }]);
        const ea = X && reprojection(origin, focal, cx, cy, X, oa), eb = X && reprojection(camera, focal, cx, cy, X, ob);
        if (X && ea.z > 0 && eb.z > 0) {
          sq += ea.error ** 2 + eb.error ** 2; ok++;
          const u = X, w = X.map((v, d) => v - center[d]);
          if (Math.acos((u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w))) > 0.06) wide++;
        }
      }
      const rms = Math.sqrt(sq / Math.max(1, 2 * ok));
      if (wide < level.minWide || rms > level.maxRms) continue;
      const score = wide * Math.min(disparity, 150) / (1 + rms);
      if (!pair || score > pair.score) { pair = { a, b, score, shared, rms }; relative = pose; }
    }
    }
  }
  if (!pair) {
    const decoded = new Set(chosen.flatMap(c => [...c.keys()])).size;
    throw new Error(`Not enough camera movement or shared lights to start the reconstruction: ${decoded} lights decoded in ${frames.length} frames, at most ${mostShared} lights seen together in two frames, largest median shift ${mostDisparity.toFixed(0)} px. Move the camera sideways around the tree (don't just rotate) and keep many lights in view.`);
  }
  log(`initial pair frames ${pair.a},${pair.b}: ${pair.shared.length} shared, ${relative.ids.length} inliers, rms ${pair.rms.toFixed(2)}px`);

  onProgress(0.1);
  const cameras = new Map();   // frame index -> {r, t}
  const points = new Map();    // light index -> [x, y, z]
  cameras.set(pair.a, { r: [0, 0, 0], t: [0, 0, 0] });
  cameras.set(pair.b, { r: vecFromRot(relative.R), t: relative.t });
  let f = focal;

  const normalized = o => ({ x: (o.x - cx) / f, y: (o.y - cy) / f });
  // Several tracklets can claim one index (reflections, mis-decodes), so pick the candidates that
  // agree on a single 3D point: RANSAC over pairs of candidates from different cameras.
  const consistentViews = id => {
    const cands = [];
    for (const [k, camera] of cameras) {
      const list = frames[k].observations.get(id);
      if (list) for (const o of list) cands.push({ k, R: rotFromVec(camera.r), t: camera.t, ...normalized(o), o, camera });
    }
    if (cands.length < 2) return cands;
    let bestViews = [];
    for (let n = 0; n < 80; n++) {
      const a = cands[Math.floor(random() * cands.length)], b = cands[Math.floor(random() * cands.length)];
      if (a.k === b.k) continue;
      const X = triangulate([a, b]);
      if (!X || X.some(v => !Number.isFinite(v))) continue;
      const perCamera = new Map();
      for (const c of cands) {
        const e = reprojection(c.camera, f, cx, cy, X, c.o);
        if (e.z > 0 && e.error < 6 && (!perCamera.has(c.k) || e.error < perCamera.get(c.k).error)) perCamera.set(c.k, { c, error: e.error });
      }
      if (perCamera.size > bestViews.length) bestViews = [...perCamera.values()].map(v => v.c);
    }
    return bestViews;
  };
  const triangulateNew = () => {
    const ids = new Set(frames.flatMap((_, k) => cameras.has(k) ? [...chosen[k].keys()] : []));
    for (const id of ids) {
      if (points.has(id)) continue;
      const views = consistentViews(id);
      if (views.length < 2) continue;
      const X = triangulate(views);
      if (!X || X.some(v => !Number.isFinite(v))) continue;
      const errors = views.map(v => reprojection(v.camera, f, cx, cy, X, v.o));
      const good = errors.filter(e => e.error < 6 && e.z > 0).length;
      const rays = views.map(v => { const c = v.R; return [-(c[0] * v.t[0] + c[3] * v.t[1] + c[6] * v.t[2]), -(c[1] * v.t[0] + c[4] * v.t[1] + c[7] * v.t[2]), -(c[2] * v.t[0] + c[5] * v.t[1] + c[8] * v.t[2])]; });
      let angle = 0;
      for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) {
        const u = rays[i].map((v, d) => v - X[d]), w = rays[j].map((v, d) => v - X[d]);
        const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
        angle = Math.max(angle, Math.acos(Math.max(-1, Math.min(1, cos))));
      }
      if (good >= Math.max(2, views.length * 0.7) && angle > 0.04) points.set(id, X);
    }
  };
  const adjust = (iterations, refineFocal = false) => {
    const order = [...cameras.keys()].sort((a, b) => a - b);
    const camIndex = new Map(order.map((k, i) => [k, i]));
    const ids = [...points.keys()], pointIndex = new Map(ids.map((id, i) => [id, i]));
    // The reference camera (frame pair.a) must be camera 0 so that it stays fixed.
    order.splice(order.indexOf(pair.a), 1); order.unshift(pair.a);
    order.forEach((k, i) => camIndex.set(k, i));
    const observations = [];
    for (const k of order) for (const [id, o] of chosen[k]) if (pointIndex.has(id)) observations.push({ c: camIndex.get(k), p: pointIndex.get(id), x: o.x, y: o.y });
    const cams = order.map(k => cameras.get(k)), pts = ids.map(id => points.get(id));
    const result = bundleAdjust(cams, pts, observations, f, cx, cy, { iterations, refineFocal });
    order.forEach((k, i) => cameras.set(k, cams[i]));
    ids.forEach((id, i) => points.set(id, pts[i]));
    f = result.focal;
    return result.rms;
  };
  // Re-pick, per frame and light, the candidate that best agrees with the current model.
  const reselect = () => {
    let changed = 0;
    frames.forEach((frame, k) => {
      const camera = cameras.get(k);
      if (!camera) return;
      for (const [id, list] of frame.observations) {
        const X = points.get(id);
        if (!X || list.length < 2) continue;
        const best = list.reduce((a, b) => reprojection(camera, f, cx, cy, X, b).error < reprojection(camera, f, cx, cy, X, a).error ? b : a);
        if (best !== chosen[k].get(id)) { chosen[k].set(id, best); changed++; }
      }
    });
    return changed;
  };

  // The rms is dominated by the few wrong candidates that remain; the median shows the typical accuracy.
  const medianError = () => {
    const errors = [];
    for (const [k, camera] of cameras) {
      for (const [id, o] of chosen[k]) if (points.has(id)) errors.push(reprojection(camera, f, cx, cy, points.get(id), o).error);
    }
    errors.sort((a, b) => a - b);
    return errors.length ? errors[errors.length >> 1] : 0;
  };

  triangulateNew();
  log(`initial points: ${points.size}`);
  adjust(15);
  onProgress(0.2);

  const register = k => {
    const known = [...chosen[k]].filter(([id]) => points.has(id));
    if (known.length < 6) return false;
    const observations = known.map(([id, o]) => ({ point: points.get(id), x: o.x, y: o.y }));
    const near = [...cameras.keys()].sort((a, b) => Math.abs(a - k) - Math.abs(b - k)).slice(0, 6);
    const starts = near.map(n => cameras.get(n));
    if (near.length >= 2) {
      // Constant-velocity extrapolation from the two closest cameras.
      const [c1, c2] = [near[0], near[1]].sort((a, b) => a - b), p1 = cameras.get(c1), p2 = cameras.get(c2);
      const s = (k - c2) / (c2 - c1);
      starts.push({ r: p2.r.map((v, i) => v + (v - p1.r[i]) * s), t: p2.t.map((v, i) => v + (v - p1.t[i]) * s) });
    }
    let camera = null, inliers = -1;
    for (const start of starts) {
      const refined = refineCamera(start, f, cx, cy, observations, { iterations: 40 });
      const count = known.filter(([id, o]) => reprojection(refined, f, cx, cy, points.get(id), o).error < 6).length;
      if (count > inliers) { inliers = count; camera = refined; }
    }
    if (inliers < Math.max(6, known.length * 0.6)) return false;
    cameras.set(k, camera);
    return true;
  };
  const sweep = indices => {
    let added = 0;
    for (const k of indices) {
      if (cameras.has(k)) continue;
      if (register(k)) {
        added++;
        triangulateNew();
        if (added % 10 === 0) adjust(6);
      }
    }
    return added;
  };
  onStage("Registering camera viewpoints");
  for (let round = 0; round < 8; round++) {
    const distance = k => Math.min(...[...cameras.keys()].map(c => Math.abs(c - k)));
    const pending = frames.map((_, k) => k).filter(k => !cameras.has(k)).sort((a, b) => distance(a) - distance(b));
    const before = cameras.size;
    // Frames next to registered ones are tried first, and each success makes the next one easier.
    const added = sweep(pending);
    log(`round ${round}: +${added} cameras, ${cameras.size}/${frames.length}, ${points.size} points`);
    onProgress(0.2 + 0.6 * cameras.size / frames.length);
    if (cameras.size === before) break;
    adjust(8);
  }
  onStage("Refining camera and light positions");
  let rms = adjust(20, true);
  for (let i = 0; i < 2; i++) {
    const changed = reselect();
    rms = adjust(15, true);
    log(`reselect ${changed}, rms ${rms.toFixed(2)}px, focal ${f.toFixed(0)}`);
    onProgress(0.8 + 0.05 * (i + 1));
  }
  // Focal refinement can make previously rejected camera poses registerable.
  onStage("Registering remaining viewpoints");
  for (let round = 0; round < 8; round++) {
    const distance = k => Math.min(...[...cameras.keys()].map(c => Math.abs(c - k)));
    const pending = frames.map((_, k) => k).filter(k => !cameras.has(k)).sort((a, b) => distance(a) - distance(b));
    const added = sweep(pending);
    log(`refined focal round ${round}: +${added} cameras, ${cameras.size}/${frames.length}, ${points.size} points`);
    if (!added) break;
    rms = adjust(15, true);
    if (reselect()) rms = adjust(15, true);
    onProgress(0.9 + 0.09 * cameras.size / frames.length);
  }
  onStage("Finalizing the model");
  onProgress(1);
  return {
    points,
    cameras: [...cameras].map(([k, c]) => ({ frame: k, time: frames[k].time, ...c })).sort((a, b) => a.time - b.time),
    focal: f,
    rms,
    medianError: medianError(),
    observations: [...chosen].reduce((n, m) => n + [...m.keys()].filter(id => points.has(id)).length, 0),
  };
}

/** The model file read by the viewer. */
export function modelToJson(model, { count, width, height }) {
  return {
    count, focal: model.focal, rms: model.rms, medianError: model.medianError, width, height,
    points: [...model.points].sort((a, b) => a[0] - b[0]).map(([index, [x, y, z]]) => ({ index, x, y, z })),
    cameras: model.cameras.map(c => ({ time: c.time, r: c.r, t: c.t })),
  };
}
