import { StreamDecoder } from "./protocol.js";

function key(x, y, size) {
  return `${Math.floor(x / size)},${Math.floor(y / size)}`;
}

function addToGrid(grid, point, size) {
  const cell = key(point.x, point.y, size);
  if (!grid.has(cell)) grid.set(cell, []);
  grid.get(cell).push(point);
}

function neighbors(grid, point, size) {
  const x = Math.floor(point.x / size), y = Math.floor(point.y / size);
  const result = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const candidate of grid.get(`${x + dx},${y + dy}`) ?? []) {
        if (Math.hypot(candidate.x - point.x, candidate.y - point.y) <= size) result.push(candidate);
      }
    }
  }
  return result;
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function consistentMotion(vectors, minimum, tolerance) {
  if (vectors.length < minimum) return null;
  const dx = median(vectors.map(vector => vector.dx));
  const dy = median(vectors.map(vector => vector.dy));
  if (vectors.filter(vector => Math.hypot(vector.dx - dx, vector.dy - dy) <= tolerance).length < vectors.length * 0.6)
    return null;
  return { dx, dy };
}

function nearestMatch(matches) {
  let best = null, second = null;
  for (const match of matches) {
    if (!best || match.distance < best.distance) {
      second = best;
      best = match;
    } else if (!second || match.distance < second.distance) second = match;
  }
  if (second && (second.distance - best.distance < 3 || second.distance < best.distance * 1.5)) return null;
  return best;
}

export function motionField(vectors) {
  const size = 80, grid = new Map();
  for (const vector of vectors) addToGrid(grid, vector, size);
  const global = consistentMotion(vectors, 12, 1.5);
  const cache = new Map(), cellSize = 32;
  return point => {
    const cx = Math.floor(point.x / cellSize), cy = Math.floor(point.y / cellSize);
    const cell = `${cx},${cy}`;
    if (!cache.has(cell)) {
      const center = { x: (cx + 0.5) * cellSize, y: (cy + 0.5) * cellSize };
      cache.set(cell, consistentMotion(neighbors(grid, center, size), 4, 3) ?? global);
    }
    return cache.get(cell);
  };
}

export class MultiLightTracker {
  constructor({ maxDistance = 12, maxGapMs = 1000, maxPersistMs = 3000 } = {}) {
    if (!Number.isFinite(maxDistance) || maxDistance <= 0 ||
      !Number.isFinite(maxGapMs) || maxGapMs <= 0 ||
      !Number.isFinite(maxPersistMs) || maxPersistMs <= 0) throw new Error("Invalid tracking limits");
    this.maxDistance = maxDistance;
    this.maxGapMs = maxGapMs;
    this.maxPersistMs = maxPersistMs;
    this.tracks = [];
    this.nextId = 1;
    this.lastTime = -Infinity;
  }

  reset() {
    this.tracks = [];
    this.lastTime = -Infinity;
  }

  observe(time, detections, { motion = null, sample = null } = {}) {
    if (!Number.isFinite(time) || time <= this.lastTime) throw new Error("Video timestamps must increase");
    if (!Array.isArray(detections) || detections.some(point =>
      !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      (point.color !== null && (!Number.isInteger(point.color) || point.color < 0 || point.color > 5))))
      throw new Error("Invalid light detection");
    if ((motion !== null && typeof motion !== "function") || (sample !== null && typeof sample !== "function"))
      throw new Error("Invalid persistence callbacks");

    const points = detections.map(point => ({ ...point, used: false, matches: [] }));
    const grid = new Map();
    for (const point of points) addToGrid(grid, point, this.maxDistance);
    const candidates = this.tracks.map(track => {
      const dt = time - track.time;
      const movement = dt <= this.maxGapMs && motion ? motion(track) : null;
      if (movement && (!Number.isFinite(movement.dx) || !Number.isFinite(movement.dy)))
        throw new Error("Invalid camera motion");
      const prediction = movement
        ? { x: track.x + movement.dx, y: track.y + movement.dy }
        : { x: track.x + track.vx * dt, y: track.y + track.vy * dt };
      const matches = dt <= this.maxGapMs
        ? neighbors(grid, prediction, this.maxDistance).map(point => ({
          point, distance: Math.hypot(point.x - prediction.x, point.y - prediction.y),
        })) : [];
      for (const match of matches) match.point.matches.push({ track, distance: match.distance });
      return { track, prediction, matches };
    });

    const next = [];
    for (const { track, prediction, matches } of candidates) {
      let point, predicted = false;
      const best = nearestMatch(matches);
      if (best && nearestMatch(best.point.matches)?.track === track) {
        point = best.point;
        point.used = true;
        track.lastSeen = time;
      } else if (time - track.time <= this.maxGapMs && sample && time - track.lastSeen <= this.maxPersistMs) {
        const sampled = sample(prediction);
        if (!sampled) continue;
        if (sampled.color !== null &&
          (!Number.isInteger(sampled.color) || sampled.color < 0 || sampled.color > 5))
          throw new Error("Invalid sampled light color");
        point = { ...prediction, color: sampled.color };
        predicted = true;
        if (point.color !== null) track.lastSeen = time;
      } else continue;
      const dt = time - track.time;
      const decoded = track.decoder.add(time, point.color);
      if (decoded && track.decoded &&
        (decoded.index !== track.decoded.index || decoded.count !== track.decoded.count)) continue;
      track.vx = (point.x - track.x) / dt;
      track.vy = (point.y - track.y) / dt;
      track.x = point.x;
      track.y = point.y;
      track.color = point.color;
      track.time = time;
      track.predicted = predicted;
      if (decoded) track.decoded = decoded;
      next.push(track);
    }
    for (const point of points) {
      if (point.used || point.matches.some(match => match.distance <= 10)) continue;
      const decoder = new StreamDecoder();
      decoder.add(time, point.color);
      next.push({
        id: this.nextId++, x: point.x, y: point.y, color: point.color, time, lastSeen: time,
        vx: 0, vy: 0, decoder, decoded: null, predicted: false,
      });
    }
    this.tracks = next;
    this.lastTime = time;
    return next.map(({ id, x, y, color, decoded, predicted }) => ({ id, x, y, color, decoded, predicted }));
  }
}
