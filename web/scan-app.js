import { AnalysisPool } from "./pool.js";
import { videoFrames, videoReadError } from "./capture.js";
import { openVideoFile } from "./file-video.js";
import { trackFrames } from "./scan.js";
import { describeError, trace } from "./diagnostics.js";

// Live scans analyze 30 fps even when the camera (and the preview) runs at 60.
const LIVE_FPS = 30;

const workerCount = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));

export function spawnAnalyzer() {
  const worker = new Worker(new URL("./analyze-worker.js", import.meta.url), { type: "module" });
  return {
    post: (message, transfer) => worker.postMessage(message, transfer),
    onMessage: handler => { worker.onmessage = e => handler(e.data); },
    onError: handler => {
      worker.onerror = e => handler(e.message || "An analysis worker stopped without a message, most likely because it ran out of memory");
      worker.onmessageerror = () => handler("An analysis worker sent data that could not be read");
    },
    terminate: () => worker.terminate(),
  };
}

function solve(tracks, { width, height }, onProgress, cancel) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./solve-worker.js", import.meta.url), { type: "module" });
    let status, fraction = 0;
    cancel?.addEventListener("abort", () => { worker.terminate(); reject(new Error("Cancelled")); });
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) { fraction = data.progress; trace.update({ solve: Math.round(fraction * 100) }); return onProgress({ fraction, status }); }
      if (data.status) { status = data.status; return onProgress({ fraction, status }); }
      if (data.stage) return trace.update({ stage: data.stage });
      if (data.log) return;
      worker.terminate();
      if (data.error) reject(Object.assign(new Error(data.error.message), { name: data.error.name, stack: data.error.stack })); else resolve(data.model);
    };
    // A worker that is killed (typically out of memory) reports no message at all.
    worker.onerror = e => {
      worker.terminate();
      const where = e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : "";
      reject(new Error(`${e.message || "The solving worker stopped without a message, most likely because it ran out of memory"}${where}`));
    };
    worker.onmessageerror = () => { worker.terminate(); reject(new Error("The solving worker sent data that could not be read")); };
    worker.postMessage({ tracks, width, height });
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
export async function scan(source, options = {}) {
  trace.clear();
  try {
    const model = await scanSource(source, options);
    trace.clear();
    return model;
  } catch (error) {
    // The details are kept on the error; a cancelled scan needs none.
    if (!options.cancel?.aborted) error.details = describeError(error);
    trace.clear();
    throw error;
  }
}

async function scanSource({ file, stream }, { signal, cancel, onProgress = () => {}, preview } = {}) {
  // Older versions cached tracklets in IndexedDB; every scan starts clean and removes those leftovers.
  indexedDB.deleteDatabase("mapper3d");
  let tracks;
  trace.update({ phase: "loading video", source: file ? `file ${file.name || ""} ${(file.size / 1e6).toFixed(1)} MB, type ${file.type || "unknown"}` : "camera" });
  let video, sourceVideo, width, height, duration;
  if (file) {
    sourceVideo = await openVideoFile(file, signal);
    ({ width, height, duration } = sourceVideo);
  } else {
    video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(videoReadError(video, "while loading metadata"));
      video.srcObject = stream;
    });
    width = video.videoWidth; height = video.videoHeight;
  }
  const replay = document.createElement("canvas");
  if (file) preview?.replaceChildren(replay);
  trace.update({ phase: "analyze", source: file ? `file ${file.name || ""} ${(file.size / 1e6).toFixed(1)} MB` : "camera", video: `${width}x${height}${file ? `, ${duration.toFixed(1)} s` : ""}`, workers: workerCount });
  const pool = new AnalysisPool(spawnAnalyzer, workerCount);
  let analyzed = 0;
  try {
    const frames = file ? sourceVideo.frames(replay, signal) : videoFrames(video, { signal, live: true, fps: LIVE_FPS });
    tracks = await trackFrames(frames, {
      analyze: frame => pool.analyze(frame),
      concurrency: workerCount + 2,
      onProgress: ({ frames, tracks: n, time }) => {
        analyzed = frames;
        if (frames % 5 === 0) trace.update({ frames, tracks: n });
        if (frames % 5 === 0) onProgress({ phase: "analyze", frames, tracks: n, fraction: file ? Math.min(1, time / (duration * 1000)) : undefined });
      },
    });
  } finally {
    pool.terminate();
    preview?.replaceChildren();
  }
  trace.update({ stage: "packing the tracks" });
  tracks = tracks.map(t => ({ samples: t.samples.map(s => ({ time: s.time, x: s.x, y: s.y, features: s.features && s.features.map(v => +v.toFixed(4)) })) }));

  if (cancel?.aborted) throw new Error("Cancelled");
  if (file && !tracks.length) throw new Error(`No lights could be decoded (${analyzed} frames analysed, ${duration.toFixed(1)} s video, ${width}x${height}). Film the whole string for longer, in a darker room.`);
  trace.update({ phase: "solve", solve: 0, stage: undefined, tracks: tracks.length, samples: tracks.reduce((sum, t) => sum + t.samples.length, 0) });
  onProgress({ phase: "solve", fraction: 0 });
  return solve(tracks, { width, height }, progress => onProgress({ phase: "solve", ...progress }), cancel);
}
