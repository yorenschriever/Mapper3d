import { classifyColor } from "./protocol.js";

function median(values) {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

export function locateLight(image, point) {
  const radius = 20;
  const x0 = Math.max(0, Math.floor(point.x) - radius);
  const y0 = Math.max(0, Math.floor(point.y) - radius);
  const x1 = Math.min(image.width, Math.floor(point.x) + radius + 1);
  const y1 = Math.min(image.height, Math.floor(point.y) + radius + 1);
  const w = x1 - x0, h = y1 - y0, stride = w + 1;
  const sums = Array.from({ length: 3 }, () => new Float64Array((w + 1) * (h + 1)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const source = ((y + y0) * image.width + x + x0) * 4;
      const target = (y + 1) * stride + x + 1;
      for (let c = 0; c < 3; c++)
        sums[c][target] = image.data[source + c] + sums[c][target - 1] +
          sums[c][target - stride] - sums[c][target - stride - 1];
    }
  }
  let best = null, bestScore = 15;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const distance = Math.hypot(x + x0 - point.x, y + y0 - point.y);
      if (distance > 10) continue;
      const left = Math.max(0, x - 9), right = Math.min(w, x + 10);
      const top = Math.max(0, y - 9), bottom = Math.min(h, y + 10);
      const area = (right - left) * (bottom - top);
      const pixel = ((y + y0) * image.width + x + x0) * 4;
      let contrast = 0;
      for (let c = 0; c < 3; c++) {
        const sum = sums[c][bottom * stride + right] - sums[c][top * stride + right] -
          sums[c][bottom * stride + left] + sums[c][top * stride + left];
        contrast = Math.max(contrast, image.data[pixel + c] - sum / area);
      }
      const score = contrast / (1 + distance / 4);
      if (score > bestScore) {
        bestScore = score;
        best = {
          x: x + x0, y: y + y0,
          color: classifyColor(image.data[pixel], image.data[pixel + 1], image.data[pixel + 2]),
        };
      }
    }
  }
  return best;
}

function grayscaleCrop(cv, image, bounds) {
  const rgba = new cv.Mat(bounds.height, bounds.width, cv.CV_8UC4);
  const gray = new cv.Mat();
  try {
    for (let y = 0; y < bounds.height; y++) {
      const start = ((bounds.y + y) * image.width + bounds.x) * 4;
      rgba.data.set(image.data.subarray(start, start + bounds.width * 4), y * bounds.width * 4);
    }
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    return gray;
  } catch (error) {
    gray.delete();
    throw error;
  } finally {
    rgba.delete();
  }
}

export class LightTracker {
  constructor(cv) {
    this.cv = cv;
    this.previous = null;
    this.bounds = null;
    this.point = null;
  }

  reset() {
    if (this.previous) this.previous.delete();
    this.previous = null;
    this.bounds = null;
    this.point = null;
  }

  observe(image, selected) {
    const cv = this.cv;
    let predicted = selected;
    if (this.previous) {
      const current = grayscaleCrop(cv, image, this.bounds);
      const mask = new cv.Mat(this.bounds.height, this.bounds.width, cv.CV_8UC1, new cv.Scalar(255));
      const corners = new cv.Mat(), next = new cv.Mat(), status = new cv.Mat(), error = new cv.Mat();
      try {
        cv.circle(mask, new cv.Point(this.point.x - this.bounds.x, this.point.y - this.bounds.y), 13,
          new cv.Scalar(0), -1);
        cv.goodFeaturesToTrack(this.previous, corners, 60, 0.01, 5, mask);
        if (corners.rows < 4) return null;
        cv.calcOpticalFlowPyrLK(this.previous, current, corners, next, status, error, new cv.Size(21, 21), 3);
        const dx = [], dy = [];
        for (let i = 0; i < corners.rows; i++) {
          if (!status.data[i]) continue;
          dx.push(next.data32F[i * 2] - corners.data32F[i * 2]);
          dy.push(next.data32F[i * 2 + 1] - corners.data32F[i * 2 + 1]);
        }
        if (dx.length < 4) return null;
        predicted = { x: this.point.x + median(dx), y: this.point.y + median(dy) };
      } finally {
        current.delete();
        mask.delete();
        corners.delete();
        next.delete();
        status.delete();
        error.delete();
      }
    }
    if (predicted.x < 0 || predicted.y < 0 || predicted.x >= image.width || predicted.y >= image.height) return null;
    const found = locateLight(image, predicted);
    const point = found ?? predicted;
    const x = Math.max(0, Math.floor(point.x) - 55);
    const y = Math.max(0, Math.floor(point.y) - 55);
    const bounds = {
      x, y,
      width: Math.min(image.width, Math.floor(point.x) + 56) - x,
      height: Math.min(image.height, Math.floor(point.y) + 56) - y,
    };
    if (bounds.width < 42 || bounds.height < 42) return null;
    const gray = grayscaleCrop(cv, image, bounds);
    if (this.previous) this.previous.delete();
    this.previous = gray;
    this.bounds = bounds;
    this.point = point;
    return found;
  }
}
