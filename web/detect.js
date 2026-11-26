/**
 * Finds blinking lights in a stationary recording. Lights change color every few frames while the
 * scene does not, so the per-pixel temporal variance of the color channels, summed over a small
 * neighborhood, peaks on the lights.
 */
export class LightDetector {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.frames = 0;
    this.mean = new Float32Array(width * height * 3);
    this.m2 = new Float32Array(width * height * 3);
  }

  addFrame(data) {
    const n = ++this.frames, { mean, m2 } = this;
    for (let i = 0, p = 0; p < this.width * this.height; p++, i += 4) {
      for (let c = 0; c < 3; c++) {
        const k = p * 3 + c, delta = data[i + c] - mean[k];
        mean[k] += delta / n;
        m2[k] += delta * (data[i + c] - mean[k]);
      }
    }
  }

  /** Moves a point to the brightest spot (3x3 mean of the average frame) within `radius` pixels, and reports that brightness. */
  refine(point, radius = 12) {
    const { width, height, mean } = this;
    // Whiteness counts extra: the direct view of a light clips toward white, a reflection stays colored.
    const level = (x, y) => {
      const i = (y * width + x) * 3;
      return mean[i] + mean[i + 1] + mean[i + 2] + 3 * Math.min(mean[i], mean[i + 1], mean[i + 2]);
    };
    let best = { x: Math.round(point.x), y: Math.round(point.y), brightness: 0 }, bestValue = -1;
    for (let y = Math.max(1, Math.round(point.y) - radius); y <= Math.min(height - 2, Math.round(point.y) + radius); y++) {
      for (let x = Math.max(1, Math.round(point.x) - radius); x <= Math.min(width - 2, Math.round(point.x) + radius); x++) {
        if (Math.hypot(x - point.x, y - point.y) > radius) continue;
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += level(x + dx, y + dy);
        if (sum > bestValue) { bestValue = sum; best = { x, y, brightness: sum / 9 }; }
      }
    }
    return best;
  }

  /** Local maxima of the smoothed variance map, strongest first: [{x, y, score}]. */
  candidates({ radius = 2, separation = 10, maxCount = 400, minRelative = 0.25 } = {}) {
    const { width, height, m2, frames } = this;
    const raw = new Float32Array(width * height);
    for (let p = 0; p < raw.length; p++) raw[p] = Math.sqrt((m2[p * 3] + m2[p * 3 + 1] + m2[p * 3 + 2]) / Math.max(1, frames));
    const smooth = boxBlur(boxBlur(raw, width, height, radius), width, height, radius);
    let top = 0;
    for (const v of smooth) if (v > top) top = v;
    const pixels = [];
    for (let p = 0; p < smooth.length; p++) if (smooth[p] >= top * minRelative) pixels.push(p);
    pixels.sort((p, q) => smooth[q] - smooth[p]);
    // Greedy non-maximum suppression: strongest pixel first, nothing else within `separation` of it.
    const peaks = [], cell = separation, columns = Math.ceil(width / cell), grid = new Map();
    for (const p of pixels) {
      const x = p % width, y = (p - x) / width, gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      let blocked = false;
      for (let j = gy - 1; j <= gy + 1 && !blocked; j++) {
        for (let i = gx - 1; i <= gx + 1; i++) {
          if (grid.get(j * columns + i)?.some(q => Math.hypot(q.x - x, q.y - y) < separation)) { blocked = true; break; }
        }
      }
      if (blocked) continue;
      const peak = { x, y, score: smooth[p] };
      peaks.push(peak);
      const key = gy * columns + gx;
      grid.set(key, [...(grid.get(key) ?? []), peak]);
    }
    return peaks.filter(p => p.score >= top * minRelative).slice(0, maxCount);
  }
}

function boxBlur(source, width, height, radius) {
  const tmp = new Float32Array(source.length), out = new Float32Array(source.length), size = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += source[y * width + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = sum / size;
      sum += source[y * width + Math.min(width - 1, x + radius + 1)] - source[y * width + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / size;
      sum += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}
