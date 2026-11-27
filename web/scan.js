import { LightDetector } from "./detect.js";
import { colorFeatures } from "./stationary.js";
import { decodeStationaryLights } from "./decode2.js";
import { FRAME_SLOTS } from "./code.js";
import { analyzeFrame } from "./analyze.js";
import { SpotTracker } from "./track.js";

/**
 * Finds and decodes all lights in a stationary recording.
 * openFrames() returns a fresh async iterable of {width, height, data (RGBA), time (ms)}; it is
 * read twice: once to find blinking lights, once to collect their color descriptors.
 * Returns { count, period, lights: [{index, x, y, margin}] } with one entry per decoded index.
 */
export async function scanStationary(openFrames, options = {}) {
  let detector;
  for await (const frame of openFrames()) {
    detector ??= new LightDetector(frame.width, frame.height);
    detector.addFrame(frame.data);
  }
  if (!detector) return { count: 0, period: 0, lights: [] };

  const candidates = [];
  for (const peak of detector.candidates()) {
    const spot = detector.refine(peak);
    if (!candidates.some(c => Math.hypot(c.x - spot.x, c.y - spot.y) < 6)) candidates.push({ ...spot, score: peak.score });
  }

  const samples = candidates.map(() => []);
  for await (const frame of openFrames()) {
    candidates.forEach((c, k) => samples[k].push({ time: frame.time, features: colorFeatures(frame, c) }));
  }
  const result = decodeStationaryLights(samples, options);

  const best = new Map();
  result.lights.forEach((light, k) => {
    if (!light.accepted) return;
    const known = best.get(light.index);
    // Reflections decode to the same index; the direct view of the light is the brightest.
    if (!known || known.brightness < candidates[k].brightness) {
      best.set(light.index, { index: light.index, x: candidates[k].x, y: candidates[k].y, margin: light.margin, brightness: candidates[k].brightness });
    }
  });
  return { count: result.count, period: result.period, lights: [...best.values()].sort((a, b) => a.index - b.index) };
}

/** Bump when frame analysis, tracking or descriptors change, so that cached tracks are not reused. */
export const PIPELINE_VERSION = 4;

/** Maps `source` through async `fn` with up to `limit` calls in flight, yielding results in order. */
export async function* orderedMap(source, fn, limit) {
  const pending = [];
  for await (const item of source) {
    pending.push(fn(item));
    if (pending.length >= limit) yield await pending.shift();
  }
  while (pending.length) yield await pending.shift();
}

/**
 * Detects and tracks lights over a recording with a moving camera. `analyze(frame)` may be async
 * (for example a worker pool); up to `concurrency` frames are analyzed at once.
 * Returns the tracklets with the most colorful samples first.
 */
export async function trackFrames(frames, { analyze = analyzeFrame, concurrency = 1, maxTracks = 600, minSamples = 30, minRepeat = MIN_REPEAT, periods = [120], onProgress } = {}) {
  // Tracks that end before they have `minSamples` described samples can never be returned, so they are dropped as they end.
  const tracker = new SpotTracker({ minSamples });
  let n = 0;
  const analyzed = orderedMap(frames, async frame => [frame.time, await analyze(frame)], concurrency);
  for await (const [time, spots] of analyzed) {
    tracker.update(time, spots);
    onProgress?.({ frames: ++n, time, tracks: tracker.tracks.length });
  }
  // Clutter is dropped before the cap, so it cannot push real lights out of it.
  const repeating = tracker.result(minSamples).filter(({ samples }) => repeatsWithCode(samples, periods, minRepeat));
  return repeating.slice(0, maxTracks);
}

/** Tracklets scoring below this on `repeatScore` do not repeat with the code period, so they are not lights. */
export const MIN_REPEAT = 0.1;

/** Whether a tracklet's colors repeat after one code frame. Tracklets too short to judge pass. */
function repeatsWithCode(samples, periods, minRepeat) {
  const colored = samples.filter(s => s.features);
  return !colored.length || Math.max(...periods.map(p => repeatScore(colored, p * FRAME_SLOTS))) >= minRepeat;
}

/**
 * How well a tracklet's color descriptors repeat after one code frame (-1..1). Real lights repeat
 * their pattern every frame; reflections, glints and tracks that hop between lights do not.
 * Returns 1 when the tracklet is too short to judge (covers under 1.2 frames).
 */
export function repeatScore(samples, lag, step = 8) {
  if (samples.length < 2 || samples.at(-1).time - samples[0].time < 1.2 * lag) return 1;
  const dims = samples[0].features.length, start = samples[0].time;
  const grid = [];
  for (let i = 0, g = start, t = 0; g <= samples.at(-1).time; g += step) {
    while (i < samples.length - 1 && samples[i].time < g) i++;
    grid[t++] = samples[i].features;
  }
  const mean = new Array(dims).fill(0);
  for (const f of grid) for (let q = 0; q < dims; q++) mean[q] += f[q] / grid.length;
  const k = Math.round(lag / step);
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i + k < grid.length; i++) {
    for (let q = 0; q < dims; q++) {
      const u = grid[i][q] - mean[q], v = grid[i + k][q] - mean[q];
      dot += u * v; a += u * u; b += v * v;
    }
  }
  return a && b ? dot / Math.sqrt(a * b) : -1;
}

/**
 * Decodes tracklets; all lights share one clock, so they are folded by absolute video time.
 * In cluttered scenes the many non-light tracklets swamp the color calibration, so when that
 * decodes almost nothing it is repeated with only the tracklets that repeat with the code period.
 */
export function decodeTracks(tracks, options = {}) {
  if (!tracks.length) return { count: 0, period: 0, tracks: [] };
  const periods = options.periods ?? [120, 360];
  const all = tracks.map((t, k) => ({ k, samples: t.samples.filter(s => s.features) }));
  // Tracklets that repeat with the code period may fill indices that no confident light has.
  const fillFrom = all.map((t, i) => [t, i]).filter(([t]) => Math.max(...periods.map(p => repeatScore(t.samples, p * FRAME_SLOTS))) >= 0.2).map(([, i]) => i);
  const run = (kept, calibrateOn = null) => {
    const result = decodeStationaryLights(kept.map(t => t.samples), { ...options, calibrateOn, fillFrom });
    return { result, kept, accepted: result.lights.filter(l => l.accepted).length };
  };
  let best = run(all);
  if (best.accepted < 3) {
    const repeating = all.filter(({ samples }) => Math.max(...periods.map(p => repeatScore(samples, p * FRAME_SLOTS))) >= 0.35);
    if (repeating.length >= 3 && repeating.length < all.length) {
      // Calibrate the colors on the tracklets that repeat, but still decode all of them.
      const retry = run(all, repeating.map(t => all.indexOf(t)));
      if (retry.accepted > best.accepted) best = retry;
    }
  }
  return {
    count: best.result.count,
    period: best.result.period,
    tracks: best.result.lights.flatMap((light, i) => light.accepted ? [{
      index: light.index,
      margin: light.margin,
      samples: tracks[best.kept[i].k].samples.map(({ time, x, y }) => ({ time, x, y })),
    }] : []),
  };
}

/**
 * Finds, tracks and decodes lights in a recording with a moving camera.
 * frames: async iterable of {width, height, data (RGBA), time (ms)}, or a function returning one
 * (only called when the tracklets are not cached). With `cache` ({get, set}, async) and `cacheKey`
 * (identifying the video), tracklets are stored and later runs skip the frame analysis.
 * Returns { count, period, tracks: [{index, margin, samples: [{time, x, y}]}] }: one entry per
 * decoded tracklet (an index usually has several, and reflections may add more).
 */
export async function scanMoving(frames, { cache, cacheKey, analyze, concurrency, maxTracks, minSamples, onProgress, ...options } = {}) {
  const key = cacheKey && `${cacheKey}:v${PIPELINE_VERSION}:${maxTracks ?? 600}:${minSamples ?? 30}`;
  let tracks = key && cache ? await cache.get(key) : null;
  if (!tracks) {
    tracks = await trackFrames(typeof frames === "function" ? frames() : frames, { analyze, concurrency, maxTracks, minSamples, periods: options.periods, onProgress });
    tracks = tracks.map(t => ({ samples: t.samples.map(s => ({ time: s.time, x: s.x, y: s.y, features: s.features && s.features.map(v => +v.toFixed(4)) })) }));
    if (key && cache) await cache.set(key, tracks);
  }
  return decodeTracks(tracks, options);
}
