import { scan } from "./scan-app.js";
import { alignModel, cameraCenters, project3d } from "./view-math.js";

const canvas = document.getElementById("view"), ctx = canvas.getContext("2d"), info = document.getElementById("info");
const options = { lines: "lines", labels: "labels", cameras: "cameras", chase: "chase" };
const flag = id => document.getElementById(id).checked;
let model = null, yaw = 0.6, pitch = 0.5, zoom = 1, pan = { x: 0, y: 0 }, hover = null;

function resize() {
  const ratio = devicePixelRatio || 1;
  canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function load(json) {
  const raw = JSON.parse(json);
  const lights = raw.points.map(p => [p.x, p.y, p.z]);
  const centers = cameraCenters(raw.cameras);
  const aligned = alignModel(lights, centers);
  model = { raw, lights: aligned.lights, centers: aligned.centers, indices: raw.points.map(p => p.index), radius: aligned.radius };
  info.textContent = `${raw.points.length} of ${raw.count} lights, ${raw.cameras.length} camera poses, median reprojection ${(raw.medianError ?? raw.rms).toFixed(1)} px`;
  draw();
}

function view() {
  const scale = Math.min(innerWidth, innerHeight) / (2.4 * model.radius) * zoom;
  return { yaw, pitch, scale, cx: innerWidth / 2 + pan.x, cy: innerHeight / 2 + pan.y };
}

const color = (i, count, bright = 1) => `hsl(${(i / Math.max(1, count)) * 300} 90% ${55 * bright}%)`;

// All redraw requests are coalesced into one frame, and the chase animation keeps one loop running.
let frameRequested = false;
function draw() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => { frameRequested = false; render(); });
}

function render() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  if (!model) return;
  const v = view(), count = model.raw.count;
  const screen = model.lights.map(p => project3d(p, v));
  const byIndex = new Map(model.indices.map((index, k) => [index, screen[k]]));
  if (flag("cameras") && model.centers.length > 1) {
    ctx.strokeStyle = "#5a7"; ctx.lineWidth = 1; ctx.beginPath();
    model.centers.forEach((c, k) => { const s = project3d(c, v); k ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.stroke();
  }
  if (flag("lines")) {
    ctx.strokeStyle = "#889"; ctx.lineWidth = 1.5; ctx.beginPath();
    [...byIndex.keys()].sort((a, b) => a - b).forEach((index, n, all) => {
      const s = byIndex.get(index);
      if (n && all[n - 1] === index - 1) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
    });
    ctx.stroke();
  }
  const phase = flag("chase") ? (performance.now() / 150) % count : -1;
  const order = model.indices.map((_, k) => k).sort((a, b) => screen[b].depth - screen[a].depth);
  for (const k of order) {
    const s = screen[k], index = model.indices[k];
    const lit = phase < 0 ? 1 : Math.max(0.15, 1 - ((phase - index + count) % count) / 5);
    ctx.fillStyle = color(index, count, lit);
    ctx.globalAlpha = Math.min(1, 0.35 + lit);
    ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, 2 * Math.PI); ctx.fill();
    ctx.globalAlpha = 1;
    if (flag("labels")) { ctx.fillStyle = "#fff"; ctx.fillText(String(index), s.x + 8, s.y - 8); }
  }
  if (hover !== null) {
    const s = screen[hover], p = model.raw.points[hover];
    ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.arc(s.x, s.y, 12, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillText(`LED ${p.index}`, s.x + 14, s.y + 4);
  }
  if (flag("chase")) draw();
}

let drag = null;
canvas.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey }; canvas.classList.add("dragging"); canvas.setPointerCapture(e.pointerId); });
for (const type of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(type, () => { drag = null; canvas.classList.remove("dragging"); });
}
canvas.addEventListener("pointermove", e => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) { pan.x += dx; pan.y += dy; } else { yaw += dx * 0.01; pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.01)); }
    draw();
  } else if (model) {
    const v = view();
    let best = null, bestD = 14;
    model.lights.forEach((p, k) => { const s = project3d(p, v), d = Math.hypot(s.x - e.clientX, s.y - e.clientY); if (d < bestD) { bestD = d; best = k; } });
    if (best !== hover) { hover = best; draw(); }
  }
});
canvas.addEventListener("wheel", e => { e.preventDefault(); zoom *= Math.exp(-e.deltaY * 0.001); draw(); }, { passive: false });
for (const id of Object.values(options)) document.getElementById(id).addEventListener("change", draw);
document.getElementById("file").addEventListener("change", async e => { if (e.target.files[0]) load(await e.target.files[0].text()); });
// Exposure compensation, where the browser supports it (Chrome on Android does; iOS Safari does not).
const DEFAULT_EV = -3;
function setupExposure(track) {
  const box = document.getElementById("exposureBox"), slider = document.getElementById("exposure"), label = document.getElementById("exposureValue");
  const range = track.getCapabilities?.().exposureCompensation;
  if (!range) { info.textContent = "This browser does not support exposure compensation; lower the exposure in the camera app instead."; return; }
  slider.min = range.min; slider.max = range.max; slider.step = range.step || 0.1;
  const apply = value => {
    label.textContent = Number(value).toFixed(1);
    track.applyConstraints({ advanced: [{ exposureMode: "continuous", exposureCompensation: Number(value) }] }).catch(() => {});
  };
  slider.value = Math.min(range.max, Math.max(range.min, DEFAULT_EV));
  slider.oninput = () => apply(slider.value);
  apply(slider.value);
  box.hidden = false;
}

let scanning = null;
async function runScan(source, controller = new AbortController()) {
  if (scanning) return;
  scanning = controller;
  const stop = document.getElementById("stop");
  stop.hidden = !source.stream;
  try {
    load(JSON.stringify(await scan(source, { signal: controller.signal, preview: document.getElementById("preview"), onStatus: text => { info.textContent = text; } })));
  } catch (error) {
    info.textContent = `Scan failed: ${error.message}`;
  } finally {
    source.stream?.getTracks().forEach(t => t.stop());
    stop.hidden = true;
    document.getElementById("exposureBox").hidden = true;
    scanning = null;
  }
}
document.getElementById("video").addEventListener("change", e => { if (e.target.files[0]) runScan({ file: e.target.files[0] }); });
document.getElementById("webcam").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) { info.textContent = "The camera needs a secure context: open this page over https (npm run serve) or on localhost."; return; }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: 1280, height: 720, frameRate: 60 } });
  setupExposure(stream.getVideoTracks()[0]);
  runScan({ stream });
});
document.getElementById("stop").addEventListener("click", () => scanning?.abort());
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", async e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (file.type.startsWith("video/")) runScan({ file }); else load(await file.text());
});
addEventListener("resize", resize);

resize();
const url = new URLSearchParams(location.search).get("model") ?? "model.json";
fetch(url).then(r => r.ok ? r.text() : null).then(t => { if (t) load(t); }).catch(() => {});
