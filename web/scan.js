import { LightDetector } from "./detect.js";
import { colorFeatures } from "./stationary.js";
import { decodeStationaryLights } from "./decode2.js";
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
export const PIPELINE_VERSION = 3;

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
export async function trackFrames(frames, { analyze = analyzeFrame, concurrency = 1, maxTracks = 300, minSamples = 30, onProgress } = {}) {
  const tracker = new SpotTracker();
  let n = 0;
  const analyzed = orderedMap(frames, async frame => [frame.time, await analyze(frame)], concurrency);
  for await (const [time, spots] of analyzed) {
    tracker.update(time, spots);
    onProgress?.({ frames: ++n, time, tracks: tracker.tracks.length });
  }
  return tracker.result(minSamples).slice(0, maxTracks);
}

/** Decodes tracklets; all lights share one clock, so they are folded by absolute video time. */
export function decodeTracks(tracks, options = {}) {
  if (!tracks.length) return { count: 0, period: 0, tracks: [] };
  const described = tracks.map(t => t.samples.filter(s => s.features));
  const result = decodeStationaryLights(described, options);
  return {
    count: result.count,
    period: result.period,
    tracks: result.lights.flatMap((light, k) => light.accepted ? [{
      index: light.index,
      margin: light.margin,
      samples: tracks[k].samples.map(({ time, x, y }) => ({ time, x, y })),
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
  const key = cacheKey && `${cacheKey}:v${PIPELINE_VERSION}:${maxTracks ?? 300}:${minSamples ?? 30}`;
  let tracks = key && cache ? await cache.get(key) : null;
  if (!tracks) {
    tracks = await trackFrames(typeof frames === "function" ? frames() : frames, { analyze, concurrency, maxTracks, minSamples, onProgress });
    tracks = tracks.map(t => ({ samples: t.samples.map(s => ({ time: s.time, x: s.x, y: s.y, features: s.features && s.features.map(v => +v.toFixed(4)) })) }));
    if (key && cache) await cache.set(key, tracks);
  }
  return decodeTracks(tracks, options);
}
