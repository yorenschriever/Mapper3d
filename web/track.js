/**
 * Tracks spots from frame to frame while the camera moves. Spots come from analyzeFrame(); a
 * spot's descriptor may be missing (the frame analysis skips spots that are not colorful), in
 * which case the sample still records the position.
 */
const median = values => { const v = [...values].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; };

export class SpotTracker {
  constructor({ gate = 10, maxMissed = 4 } = {}) {
    this.gate = gate;
    this.maxMissed = maxMissed;
    this.tracks = [];
    this.finished = [];
    this.motion = { x: 0, y: 0 }; // per nominal frame interval
    this.lastTime = null;
    this.intervals = [];
  }

  /** Adds one frame's spots; each track collects {time, x, y, features}. */
  update(time, spots) {
    // Frames can be missing (dropped by a player, or a variable frame rate), so motion is scaled by the elapsed time.
    let steps = 1;
    if (this.lastTime !== null && time > this.lastTime) {
      this.intervals.push(time - this.lastTime);
      if (this.intervals.length > 31) this.intervals.shift();
      steps = Math.max(1, Math.round((time - this.lastTime) / median(this.intervals)));
    }
    this.lastTime = time;
    const pairs = [], cell = this.gate, grid = new Map();
    spots.forEach((spot, s) => {
      const key = Math.floor(spot.x / cell) * 65536 + Math.floor(spot.y / cell);
      const list = grid.get(key);
      if (list) list.push(s); else grid.set(key, [s]);
    });
    this.tracks.forEach((track, t) => {
      const px = track.x + steps * this.motion.x, py = track.y + steps * this.motion.y;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      for (let i = gx - 1; i <= gx + 1; i++) {
        for (let j = gy - 1; j <= gy + 1; j++) {
          for (const s of grid.get(i * 65536 + j) ?? []) {
            const d = Math.hypot(spots[s].x - px, spots[s].y - py);
            if (d <= this.gate) pairs.push({ t, s, d });
          }
        }
      }
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedTrack = new Set(), usedSpot = new Set(), dx = [], dy = [];
    for (const { t, s } of pairs) {
      if (usedTrack.has(t) || usedSpot.has(s)) continue;
      usedTrack.add(t); usedSpot.add(s);
      const track = this.tracks[t], spot = spots[s];
      dx.push((spot.x - track.x) / steps); dy.push((spot.y - track.y) / steps);
      track.x = spot.x; track.y = spot.y; track.missed = 0;
      track.samples.push({ time, x: spot.x, y: spot.y, features: spot.features });
    }
    if (dx.length >= 3) this.motion = { x: median(dx), y: median(dy) };
    const alive = [];
    this.tracks.forEach((track, t) => {
      if (usedTrack.has(t)) { alive.push(track); return; }
      track.x += steps * this.motion.x; track.y += steps * this.motion.y;
      track.missed += steps;
      if (track.missed > this.maxMissed) this.finished.push(track); else alive.push(track);
    });
    spots.forEach((spot, s) => {
      if (usedSpot.has(s)) return;
      alive.push({ x: spot.x, y: spot.y, missed: 0, samples: [{ time, x: spot.x, y: spot.y, features: spot.features }] });
    });
    this.tracks = alive;
  }

  /** All tracks so far with at least `minSamples` samples that have a descriptor, most described samples first. */
  result(minSamples = 1) {
    const described = t => t.samples.filter(s => s.features).length;
    return [...this.finished, ...this.tracks].map(t => ({ t, n: described(t) })).filter(({ n }) => n >= minSamples)
      .sort((a, b) => b.n - a.n).map(({ t }) => t);
  }
}
