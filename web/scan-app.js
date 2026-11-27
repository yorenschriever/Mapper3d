import { AnalysisPool } from "./pool.js";
import { videoFrames } from "./capture.js";
import { trackFrames } from "./scan.js";

// Live scans analyze 30 fps even when the camera (and the preview) runs at 60.
const LIVE_FPS = 30;

const workerCount = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));

function spawnAnalyzer() {
  const worker = new Worker(new URL("./analyze-worker.js", import.meta.url), { type: "module" });
  return {
    post: (message, transfer) => worker.postMessage(message, transfer),
    onMessage: handler => { worker.onmessage = e => handler(e.data); },
    terminate: () => worker.terminate(),
  };
}

function solve(tracks, { width, height }, onProgress, cancel) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./solve-worker.js", import.meta.url), { type: "module" });
    cancel?.addEventListener("abort", () => { worker.terminate(); reject(new Error("Cancelled")); });
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) return onProgress(data.progress);
      if (data.log) return;
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
 * Aborting `cancel` abandons the scan; the promise then rejects.
 * `onProgress` gets {phase: "analyze", frames, tracks, fraction} (fraction is only known for a file)
 * and {phase: "solve", fraction}. For a file, a canvas replaying the analyzed frames is put in the `preview` element.
 */
export async function scan({ file, stream }, { signal, cancel, onProgress = () => {}, preview } = {}) {
  // Older versions cached tracklets in IndexedDB; every scan starts clean and removes those leftovers.
  indexedDB.deleteDatabase("mapper3d");
  let tracks;
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true;
  if (file) video.src = URL.createObjectURL(file); else video.srcObject = stream;
  await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("Cannot read this video")); });
  const replay = document.createElement("canvas");
  if (file) preview?.replaceChildren(replay);
  const width = video.videoWidth, height = video.videoHeight;
  const pool = new AnalysisPool(spawnAnalyzer, workerCount);
  let analyzed = 0;
  try {
    tracks = await trackFrames(videoFrames(video, { signal, live: !file, fps: file ? 0 : LIVE_FPS, canvas: replay }), {
      analyze: frame => pool.analyze(frame),
      concurrency: workerCount + 2,
      onProgress: ({ frames, tracks: n }) => {
        analyzed = frames;
        if (frames % 5 === 0) onProgress({ phase: "analyze", frames, tracks: n, fraction: file ? Math.min(1, video.currentTime / video.duration) : undefined });
      },
    });
  } finally {
    pool.terminate();
    preview?.replaceChildren();
    if (file) URL.revokeObjectURL(video.src);
  }
  tracks = tracks.map(t => ({ samples: t.samples.map(s => ({ time: s.time, x: s.x, y: s.y, features: s.features && s.features.map(v => +v.toFixed(4)) })) }));

  if (cancel?.aborted) throw new Error("Cancelled");
  if (file && !tracks.length) throw new Error(`No lights could be decoded (${analyzed} frames analysed, ${video.duration.toFixed(1)} s video, ${width}x${height}). Film the whole string for longer, in a darker room.`);
  onProgress({ phase: "solve", fraction: 0 });
  return solve(tracks, { width, height }, fraction => onProgress({ phase: "solve", fraction }), cancel);
}
