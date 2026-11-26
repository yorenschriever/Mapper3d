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

export function detectLights(cv, image, background = null) {
  const rgba = cv.matFromImageData(image);
  const blurred = background ?? new cv.Mat();
  try {
    cv.blur(rgba, blurred, new cv.Size(19, 19));
    const blurData = blurred.data;
    const scores = new Uint8Array(image.width * image.height);
    for (let pixel = 0; pixel < scores.length; pixel++) {
      const i = pixel * 4;
      if (Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) < 100) continue;
      scores[pixel] = Math.max(0, image.data[i] - blurData[i],
        image.data[i + 1] - blurData[i + 1], image.data[i + 2] - blurData[i + 2]);
    }
    const peaks = [];
    for (let y = 1; y < image.height - 1; y++) {
      for (let x = 1; x < image.width - 1; x++) {
        const index = y * image.width + x, score = scores[index];
        if (score < 25 || scores[index - 1] >= score || scores[index - image.width] >= score ||
          scores[index + 1] > score || scores[index + image.width] > score) continue;
        peaks.push({ x, y, score });
      }
    }
    peaks.sort((a, b) => b.score - a.score);
    const size = 8, grid = new Map(), found = [];
    for (const peak of peaks) {
      const cx = Math.floor(peak.x / size), cy = Math.floor(peak.y / size);
      let overlaps = false;
      for (let dy = -1; dy <= 1 && !overlaps; dy++) {
        for (let dx = -1; dx <= 1 && !overlaps; dx++) {
          overlaps = (grid.get(`${cx + dx},${cy + dy}`) ?? [])
            .some(other => Math.hypot(other.x - peak.x, other.y - peak.y) <= size);
        }
      }
      if (overlaps) continue;
      const i = (peak.y * image.width + peak.x) * 4;
      found.push({ x: peak.x, y: peak.y, color: classifyColor(image.data[i], image.data[i + 1], image.data[i + 2]) });
      const key = `${cx},${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(peak);
    }
    return found;
  } finally {
    rgba.delete();
    if (!background) blurred.delete();
  }
}

export function sampleLight(image, point, blurred = null) {
  const cx = Math.round(point.x), cy = Math.round(point.y), radius = 8;
  if (cx - radius < 0 || cy - radius < 0 || cx + radius >= image.width || cy + radius >= image.height) return null;
  const background = [0, 0, 0];
  if (blurred) {
    const offset = (cy * image.width + cx) * 4;
    for (let channel = 0; channel < 3; channel++) background[channel] = blurred[offset + channel];
  } else {
    let count = 0;
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (Math.abs(x) <= 3 && Math.abs(y) <= 3) continue;
        const offset = ((cy + y) * image.width + cx + x) * 4;
        for (let channel = 0; channel < 3; channel++) background[channel] += image.data[offset + channel];
        count++;
      }
    }
    for (let channel = 0; channel < 3; channel++) background[channel] /= count;
  }
  let color = null, bestScore = 0;
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const offset = ((cy + y) * image.width + cx + x) * 4;
      const contrast = background.map((value, channel) => Math.max(0, image.data[offset + channel] - value));
      const score = Math.max(...contrast) / (1 + Math.hypot(x, y) / 4);
      if (score > bestScore) {
        bestScore = score;
        color = classifyColor(...contrast);
      }
    }
  }
  return { color };
}

export class BackgroundMotion {
  constructor(cv) {
    this.cv = cv;
    this.previous = null;
  }

  reset() {
    if (this.previous) this.previous.delete();
    this.previous = null;
  }

  observe(image, points) {
    const cv = this.cv;
    const rgba = cv.matFromImageData(image);
    let gray = new cv.Mat();
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      if (gray.cols > 320) {
        const small = new cv.Mat();
        try {
          cv.resize(gray, small, new cv.Size(320, Math.round(gray.rows * 320 / gray.cols)));
        } catch (error) {
          small.delete();
          throw error;
        }
        gray.delete();
        gray = small;
      }
      const scaleX = image.width / gray.cols, scaleY = image.height / gray.rows;
      const flow = [];
      if (this.previous && this.previous.cols === gray.cols && this.previous.rows === gray.rows) {
        const mask = new cv.Mat(gray.rows, gray.cols, cv.CV_8UC1, new cv.Scalar(255));
        const corners = new cv.Mat(), next = new cv.Mat(), status = new cv.Mat(), error = new cv.Mat();
        const back = new cv.Mat(), backStatus = new cv.Mat(), backError = new cv.Mat();
        try {
          for (const point of points) {
            if (point.predicted || (point.color === null && !point.decoded)) continue;
            cv.circle(mask, new cv.Point(point.x / scaleX, point.y / scaleY), Math.max(2, Math.round(6 / scaleX)),
              new cv.Scalar(0), -1);
          }
          cv.goodFeaturesToTrack(this.previous, corners, 350, 0.01, 5, mask);
          if (corners.rows >= 4) {
            cv.calcOpticalFlowPyrLK(this.previous, gray, corners, next, status, error, new cv.Size(21, 21), 3);
            cv.calcOpticalFlowPyrLK(gray, this.previous, next, back, backStatus, backError, new cv.Size(21, 21), 3);
            const from = corners.data32F, to = next.data32F, reverse = back.data32F;
            const valid = status.data, reverseValid = backStatus.data, errors = error.data32F;
            for (let i = 0; i < corners.rows; i++) {
              if (!valid[i] || !reverseValid[i] || errors[i] > 30 ||
                Math.hypot(reverse[i * 2] - from[i * 2], reverse[i * 2 + 1] - from[i * 2 + 1]) > 1) continue;
              const x = from[i * 2] * scaleX, y = from[i * 2 + 1] * scaleY;
              const dx = to[i * 2] * scaleX - x, dy = to[i * 2 + 1] * scaleY - y;
              if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 60)
                flow.push({ x, y, dx, dy });
            }
          }
        } finally {
          mask.delete();
          corners.delete();
          next.delete();
          status.delete();
          error.delete();
          back.delete();
          backStatus.delete();
          backError.delete();
        }
      }
      if (this.previous) this.previous.delete();
      this.previous = gray;
      gray = null;
      return flow;
    } finally {
      rgba.delete();
      if (gray) gray.delete();
    }
  }
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
