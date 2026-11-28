import { openVideoFile } from "./file-video.js";
import { AnalysisPool } from "./pool.js";
import { orderedMap } from "./scan.js";
import { spawnAnalyzer } from "./scan-app.js";
import { SpotTracker } from "./track.js";
import { debugTracklets, indexDebugFrames } from "./debug-analysis.js";

const $ = id => document.getElementById(id);
const fileInput = $("file"), status = $("status"), error = $("error"), results = $("results");
const video = $("video"), overlay = $("overlay"), timeline = $("timeline");
const previous = $("previous"), next = $("next"), play = $("play");
const frameInfo = $("frame-info"), summary = $("summary"), selectedInfo = $("selected"), list = $("track-list");
const filter = $("filter"), search = $("search");
const labels = $("labels"), onlySelected = $("only-selected"), path = $("path");
const context = overlay.getContext("2d");
let frames = [], tracks = [], current = 0, selected = null, url = null, videoCallback = null;

const seconds = ms => (ms / 1000).toFixed(2);
const label = track => `T${track.id}${track.decoded ? ` · LED ${track.decoded.index}` : ""}`;

function nearestFrame(time) {
  let low = 0, high = frames.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (frames[mid].time < time) low = mid + 1; else high = mid;
  }
  return low > 0 && Math.abs(frames[low - 1].time - time) <= Math.abs(frames[low].time - time) ? low - 1 : low;
}

function seek(index) {
  if (!frames.length) return;
  video.pause();
  index = Math.max(0, Math.min(frames.length - 1, index));
  const nextTime = frames[index + 1]?.time ?? frames[index].time + (frames[index].time - (frames[index - 1]?.time ?? frames[index].time));
  const offset = Math.min(5, Math.max(0, (nextTime - frames[index].time) / 4));
  video.currentTime = Math.min(video.duration, Math.max(0, (frames[index].time - frames[0].time + offset) / 1000));
}

function renderFrame(index) {
  if (!frames.length) return;
  current = index;
  timeline.value = String(index);
  previous.disabled = index === 0;
  next.disabled = index === frames.length - 1;
  const frame = frames[index];
  frameInfo.textContent = `Frame ${index + 1}/${frames.length} · ${seconds(frame.time - frames[0].time)} s · ${frame.spots.length} spots · ${frame.spots.filter(s => s.described).length} with color samples`;
  context.clearRect(0, 0, overlay.width, overlay.height);
  const scale = overlay.width / Math.max(1, overlay.clientWidth);
  if (selected !== null && path.checked) {
    const samples = tracks[selected].track.samples;
    context.strokeStyle = "#56c8ff";
    context.lineWidth = 2 * scale;
    context.beginPath();
    samples.forEach((s, i) => i ? context.lineTo(s.x, s.y) : context.moveTo(s.x, s.y));
    context.stroke();
  }
  context.font = `bold ${Math.max(12, 12 * scale)}px system-ui`;
  context.textBaseline = "bottom";
  for (const spot of frame.spots) {
    const track = tracks[spot.tracklet];
    if (!track) continue;
    if (onlySelected.checked && spot.tracklet !== selected) continue;
    const color = track.decoded ? "#58ee7a" : spot.described ? "#ffbc4c" : "#b7c1d0";
    context.strokeStyle = color;
    context.lineWidth = (spot.tracklet === selected ? 3 : 1.5) * scale;
    context.beginPath();
    context.arc(spot.x, spot.y, (spot.tracklet === selected ? 8 : 6) * scale, 0, 2 * Math.PI);
    context.stroke();
    if (labels.checked) {
      const text = track.decoded ? `T${track.id} LED${track.decoded.index}` : `T${track.id}`;
      context.lineWidth = 3 * scale;
      context.strokeStyle = "#000";
      context.strokeText(text, spot.x + 7 * scale, spot.y - 5 * scale);
      context.fillStyle = color;
      context.fillText(text, spot.x + 7 * scale, spot.y - 5 * scale);
    }
  }
  updateSelected();
}

function updateList() {
  const query = search.value.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  for (const track of tracks) {
    if (filter.value !== "all" && track.status !== filter.value) continue;
    if (query && !`${track.id} ${track.decoded?.index ?? ""} ${label(track)}`.toLowerCase().includes(query)) continue;
    const button = document.createElement("button"), details = document.createElement("small");
    const samples = track.track.samples;
    button.type = "button";
    button.className = `track${selected === track.id ? " selected" : ""}`;
    button.append(document.createTextNode(label(track)));
    details.textContent = `${seconds(samples[0].time - frames[0].time)}–${seconds(samples.at(-1).time - frames[0].time)} s · ${track.described}/${samples.length} color samples · ${track.status}`;
    button.append(details);
    button.addEventListener("click", () => selectTrack(track.id));
    fragment.append(button);
  }
  list.replaceChildren(fragment);
}

function updateSelected() {
  if (selected === null) return;
  const track = tracks[selected], samples = track.track.samples;
  const spot = frames[current].spots.find(s => s.tracklet === selected);
  const atFrame = spot ? ` · this frame: (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}), contrast ${spot.contrast.toFixed(1)}, ${spot.described ? "color sampled" : "no color sample"}` : " · not detected in this frame";
  const features = spot?.features ? ` · descriptor (peak RGB, grey ratio, inner RGB, outer RGB): ${spot.features.map(v => v.toFixed(2)).join(", ")}` : "";
  selectedInfo.textContent = `${label(track)} · ${track.status} · ${samples.length} detections, ${track.described} color samples · ${seconds(samples[0].time - frames[0].time)}–${seconds(samples.at(-1).time - frames[0].time)} s${track.decoded ? ` · decode margin ${track.decoded.margin.toFixed(2)}` : ""}${atFrame}${features}`;
}

function selectTrack(id) {
  selected = id;
  const samples = tracks[id].track.samples;
  updateList();
  if (!samples.some(s => s.time === frames[current].time)) seek(nearestFrame(samples[0].time));
  renderFrame(current);
}

function waitForVideo() {
  return new Promise((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("The browser could not open this video for playback.")); };
    const cleanup = () => { video.removeEventListener("loadeddata", ready); video.removeEventListener("error", failed); };
    video.addEventListener("loadeddata", ready);
    video.addEventListener("error", failed);
    video.load();
  });
}

function decode(tracks) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./debug-solve-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => { worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data); };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || "The decoding worker stopped unexpectedly.")); };
    worker.onmessageerror = () => { worker.terminate(); reject(new Error("The decoding worker sent an unreadable message.")); };
    try { worker.postMessage(tracks); } catch (e) { worker.terminate(); reject(e); }
  });
}

async function analyze(file) {
  fileInput.disabled = true;
  results.hidden = true;
  error.hidden = true;
  video.pause();
  if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback);
  videoCallback = null;
  if (url) URL.revokeObjectURL(url);
  url = null;
  frames = []; tracks = []; selected = null; current = 0;
  selectedInfo.textContent = "Select a tracklet for details.";
  filter.value = "all"; search.value = "";
  let pool;
  try {
    status.textContent = "Opening video…";
    const source = await openVideoFile(file);
    const tracker = new SpotTracker({ minSamples: 0 });
    const workers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
    pool = new AnalysisPool(spawnAnalyzer, workers);
    const analyzed = orderedMap(source.frames(document.createElement("canvas")), async frame => ({
      time: frame.time, spots: await pool.analyze(frame),
    }), workers + 2);
    for await (const frame of analyzed) {
      tracker.update(frame.time, frame.spots);
      frames.push({ time: frame.time, spots: frame.spots.map(({ x, y, contrast, features }) => ({ x, y, contrast, features, described: !!features })) });
      if (frames.length % 5 === 0) status.textContent = `Analyzing frame ${frames.length} · ${Math.min(100, Math.round(frame.time / (source.duration * 1000) * 100))}%`;
    }
    pool.terminate(); pool = null;
    if (!frames.length) throw new Error("The video contained no analyzed frames.");
    tracks = debugTracklets(tracker);
    indexDebugFrames(frames, tracks);
    const retained = tracks.filter(t => t.status === "not decoded");
    const packed = retained.map(({ track }) => ({ samples: track.samples.map(s => ({
      time: s.time, x: s.x, y: s.y, features: s.features && s.features.map(v => +v.toFixed(4)),
    })) }));
    status.textContent = `Decoding ${retained.length} tracklets…`;
    let count = null;
    try {
      const decoded = await decode(packed);
      count = decoded.count > 0 ? decoded.count : null;
      for (const light of decoded.decoded) {
        const track = retained[light.source];
        track.decoded = light;
        track.status = "decoded";
      }
    } catch (e) {
      retained.forEach(track => { track.status = "decode failed"; });
      error.textContent = `Decoding failed: ${e.message}. Spot and tracklet data are still available.`;
      error.hidden = false;
    }
    url = URL.createObjectURL(file);
    video.src = url;
    await waitForVideo();
    overlay.width = source.width; overlay.height = source.height;
    timeline.max = String(frames.length - 1);
    const decodedCount = new Set(tracks.filter(t => t.decoded).map(t => t.decoded.index)).size;
    summary.textContent = `${tracks.length} tracklets · ${retained.length} sent to decoder · ${decodedCount}${count === null ? "" : ` / ${count}`} distinct LED IDs`;
    status.textContent = `Analysis complete: ${frames.length} frames.`;
    results.hidden = false;
    updateList();
    renderFrame(0);
    if (video.requestVideoFrameCallback) {
      const presented = (_, metadata) => {
        renderFrame(nearestFrame(frames[0].time + metadata.mediaTime * 1000));
        videoCallback = video.requestVideoFrameCallback(presented);
      };
      videoCallback = video.requestVideoFrameCallback(presented);
    }
  } catch (e) {
    console.error(e);
    status.textContent = "Analysis failed.";
    error.textContent = e.message || String(e);
    error.hidden = false;
  } finally {
    pool?.terminate();
    fileInput.disabled = false;
  }
}

fileInput.addEventListener("change", () => { if (fileInput.files[0]) analyze(fileInput.files[0]); });
fileInput.addEventListener("click", () => { fileInput.value = ""; });
previous.addEventListener("click", () => seek(current - 1));
next.addEventListener("click", () => seek(current + 1));
timeline.addEventListener("input", () => seek(Number(timeline.value)));
play.addEventListener("click", async () => {
  if (video.paused) {
    try { await video.play(); } catch (e) { error.textContent = `Playback failed: ${e.message}`; error.hidden = false; }
  } else video.pause();
});
video.addEventListener("play", () => { play.textContent = "Pause"; });
video.addEventListener("pause", () => { play.textContent = "Play"; });
video.addEventListener("seeked", () => {
  if (!video.requestVideoFrameCallback && frames.length) renderFrame(nearestFrame(frames[0].time + video.currentTime * 1000));
});
video.addEventListener("timeupdate", () => {
  if (!video.requestVideoFrameCallback && frames.length) renderFrame(nearestFrame(frames[0].time + video.currentTime * 1000));
});
overlay.addEventListener("click", event => {
  const rect = overlay.getBoundingClientRect();
  const x = (event.clientX - rect.left) * overlay.width / rect.width, y = (event.clientY - rect.top) * overlay.height / rect.height;
  const nearby = frames[current].spots.filter(s => s.tracklet !== undefined).map(s => ({ s, distance: Math.hypot(s.x - x, s.y - y) })).sort((a, b) => a.distance - b.distance)[0];
  if (nearby && nearby.distance <= 12 * overlay.width / rect.width) selectTrack(nearby.s.tracklet);
});
filter.addEventListener("change", updateList);
search.addEventListener("input", updateList);
[labels, onlySelected, path].forEach(input => input.addEventListener("change", () => { if (frames.length) renderFrame(current); }));
window.addEventListener("resize", () => { if (frames.length && !results.hidden) renderFrame(current); });
