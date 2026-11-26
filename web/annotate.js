const $ = id => document.getElementById(id);
const video = $("video"), canvas = $("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
let fileName = "", frame = null, frameTime = 0;
// Each entry is a click ({ index, x, y }) or a skipped index ({ index, skipped: true }).
let entries = [];

function nextIndex() {
  return entries.length ? entries[entries.length - 1].index + 1 : Number($("start").value) || 0;
}

function status(text) {
  $("status").textContent = text;
}

function redraw() {
  if (!frame) return;
  ctx.putImageData(frame, 0, 0);
  const size = Math.max(6, canvas.width / 200);
  ctx.lineWidth = Math.max(1, size / 5);
  ctx.font = `${Math.round(size * 2)}px system-ui`;
  for (const entry of entries) {
    if (entry.skipped) continue;
    ctx.strokeStyle = "#00ffd0";
    ctx.beginPath();
    ctx.arc(entry.x, entry.y, size, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(entry.index), entry.x + size * 1.2, entry.y - size * 0.5);
  }
  const placed = entries.filter(entry => !entry.skipped).length;
  status(`${placed} LEDs marked, ${entries.length - placed} skipped. Next index: ${nextIndex()}.`);
}

function applyZoom() {
  canvas.style.width = `${canvas.width * Number($("zoom").value)}px`;
}

function snap(x, y) {
  if (!$("snap").checked) return { x, y };
  const radius = 5;
  let best = null, bestScore = -1, sumX = 0, sumY = 0, sumWeight = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.round(x) + dx, py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
      const o = (py * frame.width + px) * 4;
      const score = Math.max(frame.data[o], frame.data[o + 1], frame.data[o + 2]);
      if (score > bestScore) { bestScore = score; best = { x: px, y: py }; }
    }
  }
  if (!best) return { x, y };
  // Centroid of pixels near the peak brightness, for subpixel placement.
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = best.x + dx, py = best.y + dy;
      if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
      const o = (py * frame.width + px) * 4;
      const value = Math.max(frame.data[o], frame.data[o + 1], frame.data[o + 2]);
      if (value >= bestScore * 0.8) { sumX += px * value; sumY += py * value; sumWeight += value; }
    }
  }
  return sumWeight ? { x: sumX / sumWeight, y: sumY / sumWeight } : best;
}

$("file").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  fileName = file.name;
  video.src = URL.createObjectURL(file);
  status("Seek to a frame with visible LEDs, then press Use current frame.");
});

for (const [id, direction] of [["back", -1], ["forward", 1]]) {
  $(id).addEventListener("click", () => {
    video.pause();
    video.currentTime = Math.max(0, video.currentTime + direction * Number($("step").value));
  });
}

$("capture").addEventListener("click", () => {
  if (!video.videoWidth) return status("Load a recording first.");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);
  frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  frameTime = video.currentTime;
  entries = [];
  applyZoom();
  redraw();
});

$("zoom").addEventListener("input", applyZoom);
$("start").addEventListener("change", redraw);

canvas.addEventListener("click", event => {
  if (!frame) return;
  const rect = canvas.getBoundingClientRect();
  const point = snap(
    (event.clientX - rect.left) * canvas.width / rect.width,
    (event.clientY - rect.top) * canvas.height / rect.height,
  );
  entries.push({ index: nextIndex(), x: point.x, y: point.y });
  redraw();
});

$("undo").addEventListener("click", () => { entries.pop(); redraw(); });
$("skip").addEventListener("click", () => { if (frame) { entries.push({ index: nextIndex(), skipped: true }); redraw(); } });
$("clear").addEventListener("click", () => { entries = []; redraw(); });

window.addEventListener("keydown", event => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "z" || event.key === "Backspace") $("undo").click();
  if (event.key === "s") $("skip").click();
});

$("save").addEventListener("click", () => {
  if (!frame) return status("Nothing to save yet.");
  const leds = entries.filter(entry => !entry.skipped)
    .map(({ index, x, y }) => ({ index, x: +x.toFixed(2), y: +y.toFixed(2) }));
  const data = {
    video: fileName,
    width: canvas.width,
    height: canvas.height,
    frameTime,
    ledCount: Number($("count").value) || null,
    leds,
    notVisible: entries.filter(entry => entry.skipped).map(entry => entry.index),
  };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  link.download = fileName.replace(/\.[^.]+$/, "") + ".leds.json";
  link.click();
});
