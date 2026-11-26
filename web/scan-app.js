import { AnalysisPool } from "./pool.js";
import { idbCache } from "./idb-cache.js";
import { videoFrames } from "./capture.js";
import { trackFrames, PIPELINE_VERSION } from "./scan.js";

const workerCount = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));

function spawnAnalyzer() {
  const worker = new Worker(new URL("./analyze-worker.js", import.meta.url), { type: "module" });
  return {
    post: (message, transfer) => worker.postMessage(message, transfer),
    onMessage: handler => { worker.onmessage = e => handler(e.data); },
    terminate: () => worker.terminate(),
  };
}

function solve(tracks, { width, height }, log) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./solve-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.log) return log(data.log);
      worker.terminate();
      if (data.error) reject(new Error(data.error)); else resolve(data.model);
    };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ tracks, width, height, periods: [120] });
  });
}

/**
 * Scans a recording (a File) or a live webcam stream: finds and tracks the lights on all cores,
 * then decodes and reconstructs them. Resolves with the model object the viewer reads.
 * `source` is {file} or {stream}; for a stream, abort `signal` to stop filming and start solving.
 * Tracklets of files are cached in IndexedDB, so scanning the same file again skips the video.
 */
export async function scan({ file, stream }, { signal, onStatus = () => {}, preview } = {}) {
  const cache = file ? idbCache() : null;
  const key = file && `${file.name}:${file.size}:${file.lastModified}:v${PIPELINE_VERSION}`;
  let tracks = key ? await cache.get(key) : null;
  let width, height;
  if (tracks) {
    ({ width, height } = tracks.meta);
    tracks = tracks.tracks;
    onStatus("Using cached tracklets");
  } else {
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    if (file) video.src = URL.createObjectURL(file); else video.srcObject = stream;
    preview?.replaceChildren(video);
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("Cannot read this video")); });
    width = video.videoWidth; height = video.videoHeight;
    const pool = new AnalysisPool(spawnAnalyzer, workerCount);
    const started = performance.now();
    try {
      tracks = await trackFrames(videoFrames(video, { signal, live: !file }), {
        analyze: frame => pool.analyze(frame),
        concurrency: 2 * workerCount,
        onProgress: ({ frames, tracks: n }) => {
          if (frames % 10 === 0) onStatus(`Analyzing: ${frames} frames, ${n} lights being tracked (${((performance.now() - started) / 1000).toFixed(0)} s)`);
        },
      });
    } finally {
      pool.terminate();
      preview?.replaceChildren();
      if (file) URL.revokeObjectURL(video.src);
    }
    tracks = tracks.map(t => ({ samples: t.samples.map(s => ({ time: s.time, x: s.x, y: s.y, features: s.features && s.features.map(v => +v.toFixed(4)) })) }));
    if (key) await cache.set(key, { meta: { width, height }, tracks });
  }
  onStatus("Decoding and reconstructing…");
  return solve(tracks, { width, height }, message => onStatus(`Reconstructing: ${message}`));
}
