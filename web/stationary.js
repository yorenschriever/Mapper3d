const RADIUS = 15;
const SIZE = 2 * RADIUS + 1;
export const FEATURE_COUNT = 10;

function median(values) {
  values.sort((a, b) => a - b);
  return values.length ? values[values.length >> 1] : 0;
}

function normalized(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

function readPatch(image, point) {
  const cx = Math.round(point.x), cy = Math.round(point.y);
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  const valid = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const sy = cy - RADIUS + y;
    if (sy < 0 || sy >= image.height) continue;
    for (let x = 0; x < SIZE; x++) {
      const sx = cx - RADIUS + x;
      if (sx < 0 || sx >= image.width) continue;
      const source = (sy * image.width + sx) * 4, target = y * SIZE + x;
      rgb[target * 3] = image.data[source];
      rgb[target * 3 + 1] = image.data[source + 1];
      rgb[target * 3 + 2] = image.data[source + 2];
      valid[target] = 1;
    }
  }
  return { rgb, valid };
}

// Locates the highlight and its extent; the highlight itself is usually clipped to white.
function highlight({ rgb, valid }) {
  let cx = RADIUS, cy = RADIUS, best = -1;
  for (let y = RADIUS - 6; y <= RADIUS + 6; y++) {
    for (let x = RADIUS - 6; x <= RADIUS + 6; x++) {
      const i = y * SIZE + x;
      if (!valid[i]) continue;
      const sum = rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2];
      if (sum > best) { best = sum; cx = x; cy = y; }
    }
  }
  let sx = 0, sy = 0, weight = 0, radius = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x, d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (!valid[i] || d > 8) continue;
      const m = Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      if (m >= 170) { sx += x * m; sy += y * m; weight += m; radius = Math.max(radius, d); }
    }
  }
  return weight ? { cx: sx / weight, cy: sy / weight, radius } : { cx, cy, radius };
}

function backgroundColor({ rgb, valid }, cx, cy, from) {
  const values = [[], [], []], low = from * from, high = (from + 3) * (from + 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy), i = y * SIZE + x;
      if (!valid[i] || d < low || d > high) continue;
      values[0].push(rgb[i * 3]); values[1].push(rgb[i * 3 + 1]); values[2].push(rgb[i * 3 + 2]);
    }
  }
  return values.map(median);
}

// Mean color difference to the background in a ring around the highlight.
function ring({ rgb, valid }, geometry, from, to, background, skipClipped) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x, d = Math.sqrt((x - geometry.cx) ** 2 + (y - geometry.cy) ** 2) - geometry.radius;
      if (!valid[i] || d < from || d >= to) continue;
      if (skipClipped && Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) >= 250) continue;
      for (let c = 0; c < 3; c++) sum[c] += rgb[i * 3 + c] - background[c];
      count++;
    }
  }
  return count ? sum.map(value => value / count) : [0, 0, 0];
}

/**
 * Brightness-independent color descriptor (10 values) for one light. The highlight is
 * often clipped to white, so most of the information comes from the glow in rings around
 * it, relative to the local background, plus the hue of the brightest pixels.
 */
export function colorFeatures(image, point) {
  const patch = readPatch(image, point);
  const geometry = highlight(patch);
  const { rgb, valid } = patch;
  const pixels = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (valid[i] && Math.sqrt((x - geometry.cx) ** 2 + (y - geometry.cy) ** 2) <= 6) {
        pixels.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
      }
    }
  }
  pixels.sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]));
  const top = pixels.slice(0, 6);
  const peak = [0, 1, 2].map(c => top.reduce((sum, pixel) => sum + pixel[c], 0) / (top.length || 1));
  const bright = Math.max(...peak) || 1;
  const near = backgroundColor(patch, geometry.cx, geometry.cy, geometry.radius + 9);
  const inner = ring(patch, geometry, 0, 3, near, true);
  const outer = ring(patch, geometry, 3, 7, near, false);
  return [
    ...normalized(peak), Math.min(...peak) / bright,
    ...normalized(inner),
    ...normalized(outer),
  ];
}
