import { colorFeatures, colorSamplingScale } from "./stationary.js";

/**
 * Per-frame analysis: finds small high-contrast spots (the lights are always lit, whatever their
 * color) on a half-resolution copy, refines them at input resolution, and computes a color
 * descriptor for the spots that look colorful. This per-frame work runs in the worker pool.
 */
const level = (d, i) => d[i] + d[i + 1] + d[i + 2] + 3 * Math.min(d[i], d[i + 1], d[i + 2]);

function blur(source, width, height, radius) {
  const tmp = new Float32Array(source.length), out = new Float32Array(source.length), size = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += source[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / size;
      sum += source[row + Math.min(width - 1, x + radius + 1)] - source[row + Math.max(0, x - radius)];
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

/** Local maxima of brightness contrast on the half-resolution image, in input-image coordinates. */
export function detectSpots(image, { minContrast = 60, maxSpots = 200, separation = 7 } = {}) {
  const { width, height, data } = image, w = width >> 1, h = height >> 1;
  const half = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((2 * y) * width + 2 * x) * 4, b = a + 4, c = a + width * 4, d = c + 4;
      half[y * w + x] = (level(data, a) + level(data, b) + level(data, c) + level(data, d)) / 4;
    }
  }
  const small = blur(half, w, h, 1), large = blur(half, w, h, 5);
  const pixels = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const p = y * w + x, contrast = small[p] - large[p];
      if (contrast < minContrast) continue;
      if (small[p] < small[p - 1] || small[p] < small[p + 1] || small[p] < small[p - w] || small[p] < small[p + w]) continue;
      pixels.push({ x, y, contrast });
    }
  }
  pixels.sort((a, b) => b.contrast - a.contrast);
  const kept = [];
  for (const candidate of pixels) {
    if (kept.length >= maxSpots) break;
    if (!kept.some(s => Math.abs(s.x - candidate.x) < separation && Math.abs(s.y - candidate.y) < separation)) kept.push(candidate);
  }
  // Refine at input resolution to the centroid of the pixels near the peak; saturated lights have a
  // flat top, where a single brightest pixel would be arbitrary.
  return kept.map(({ x, y, contrast }) => {
    const x0 = Math.max(0, 2 * x - 4), x1 = Math.min(width - 1, 2 * x + 5), y0 = Math.max(0, 2 * y - 4), y1 = Math.min(height - 1, 2 * y + 5);
    let peak = 0, floor = Infinity;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const v = level(data, (py * width + px) * 4);
        if (v > peak) peak = v;
        if (v < floor) floor = v;
      }
    }
    const threshold = floor + 0.7 * (peak - floor);
    let sx = 0, sy = 0, weight = 0;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const v = level(data, (py * width + px) * 4) - threshold;
        if (v > 0) { sx += px * v; sy += py * v; weight += v; }
      }
    }
    return weight ? { x: sx / weight, y: sy / weight, contrast } : { x: 2 * x, y: 2 * y, contrast };
  });
}

/**
 * How far the glow around a spot is from grey, 0..1. White tape, cable highlights and clipped
 * reflections have a grey glow; the colors of the lights do not.
 */
export function glowColorfulness(image, cx, cy) {
  const x = Math.round(cx), y = Math.round(cy);
  const { width, height, data } = image;
  const near = [0, 0, 0], far = [0, 0, 0];
  let nn = 0, nf = 0;
  for (let dy = -12; dy <= 12; dy += 2) {
    for (let dx = -12; dx <= 12; dx += 2) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), px = x + dx, py = y + dy;
      if (d < 3 || d > 12 || px < 0 || py < 0 || px >= width || py >= height) continue;
      const i = (py * width + px) * 4, target = d <= 6 ? near : far;
      target[0] += data[i]; target[1] += data[i + 1]; target[2] += data[i + 2];
      if (d <= 6) nn++; else nf++;
    }
  }
  if (!nn || !nf) return 0;
  const diff = [0, 1, 2].map(c => near[c] / nn - far[c] / nf);
  const grey = (diff[0] + diff[1] + diff[2]) / 3;
  const size = Math.hypot(...diff);
  return size < 8 ? 0 : Math.hypot(diff[0] - grey, diff[1] - grey, diff[2] - grey) / size;
}

/** Detects spots and describes the colorful ones: [{x, y, contrast, features | null}]. */
export function analyzeFrame(image, { minColorfulness = 0.08, ...options } = {}) {
  return detectSpots(image, options).map(spot => {
    const scale = colorSamplingScale(image, spot);
    return {
      ...spot,
      features: glowColorfulness(image, spot.x, spot.y) >= minColorfulness ? colorFeatures(image, spot, scale) : null,
    };
  });
}
