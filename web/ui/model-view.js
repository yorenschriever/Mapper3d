import { alignModel, cameraCenters, project3d } from "../view-math.js";

/** Turns the model file into aligned points ready to draw. */
export function prepareModel(raw) {
  const centers = cameraCenters(raw.cameras);
  const aligned = alignModel(raw.points.map(p => [p.x, p.y, p.z]), centers);
  return { raw, lights: aligned.lights, centers: aligned.centers, indices: raw.points.map(p => p.index), radius: aligned.radius };
}

const color = (index, count) => `hsl(${(index / Math.max(1, count)) * 300} 90% 58%)`;

/**
 * Draws a prepared model on a canvas and handles orbit (drag), pan (shift-drag or two fingers),
 * zoom (wheel or pinch) and tapping a light. Returns {setModel, setOptions, destroy}.
 */
export function createModelView(canvas) {
  const ctx = canvas.getContext("2d");
  let model = null, options = { lines: true, labels: true, cameras: true };
  let yaw = 0.6, pitch = 0.5, zoom = 1, pan = { x: 0, y: 0 }, selected = null;
  let width = 0, height = 0, requested = false;
  const pointers = new Map();
  let moved = 0, gesture = null;

  const resize = () => {
    const ratio = devicePixelRatio || 1, box = canvas.getBoundingClientRect();
    width = box.width; height = box.height;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const view = () => ({ yaw, pitch, scale: Math.min(width, height) / (2.4 * model.radius) * zoom, cx: width / 2 + pan.x, cy: height / 2 + pan.y });

  function draw() {
    if (requested) return;
    requested = true;
    requestAnimationFrame(() => { requested = false; render(); });
  }

  function render() {
    ctx.clearRect(0, 0, width, height);
    if (!model) return;
    const v = view(), count = model.raw.count;
    const screen = model.lights.map(p => project3d(p, v));
    const byIndex = new Map(model.indices.map((index, k) => [index, screen[k]]));
    if (options.cameras && model.centers.length > 1) {
      ctx.strokeStyle = "#5fb98a"; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7; ctx.beginPath();
      model.centers.forEach((c, k) => { const s = project3d(c, v); k ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (options.lines) {
      ctx.strokeStyle = "#8a90a8"; ctx.lineWidth = 2; ctx.beginPath();
      [...byIndex.keys()].sort((a, b) => a - b).forEach((index, n, all) => {
        const s = byIndex.get(index);
        if (n && all[n - 1] === index - 1) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
    }
    ctx.font = "12px system-ui, sans-serif";
    const order = model.indices.map((_, k) => k).sort((a, b) => screen[b].depth - screen[a].depth);
    for (const k of order) {
      const s = screen[k], index = model.indices[k];
      ctx.fillStyle = color(index, count);
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, 2 * Math.PI); ctx.fill();
      if (options.labels) { ctx.fillStyle = "#fff"; ctx.fillText(String(index), s.x + 8, s.y - 8); }
    }
    if (selected !== null && screen[selected]) {
      const s = screen[selected];
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x, s.y, 12, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = "600 14px system-ui, sans-serif";
      ctx.fillText(`LED ${model.indices[selected]}`, s.x + 16, s.y + 5);
    }
  }

  const nearest = (x, y, limit) => {
    const v = view();
    let best = null, bestDistance = limit;
    model.lights.forEach((p, k) => { const s = project3d(p, v), d = Math.hypot(s.x - x, s.y - y); if (d < bestDistance) { bestDistance = d; best = k; } });
    return best;
  };
  const local = e => { const box = canvas.getBoundingClientRect(); return { x: e.clientX - box.left, y: e.clientY - box.top }; };
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onDown = e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { ...local(e), pan: e.shiftKey });
    if (pointers.size === 1) moved = 0;
    if (pointers.size === 2) gesture = pinchState();
    canvas.classList.add("dragging");
  };
  const onMove = e => {
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (model && e.pointerType === "mouse") {
        const { x, y } = local(e), hit = nearest(x, y, 14);
        if (hit !== selected) { selected = hit; draw(); }
      }
      return;
    }
    const now = local(e);
    if (pointers.size === 2 && gesture) {
      p.x = now.x; p.y = now.y;
      const next = pinchState();
      zoom *= next.distance / gesture.distance;
      pan.x += next.x - gesture.x; pan.y += next.y - gesture.y;
      gesture = next; moved = Infinity;
    } else {
      const dx = now.x - p.x, dy = now.y - p.y;
      p.x = now.x; p.y = now.y; moved += Math.abs(dx) + Math.abs(dy);
      if (p.pan) { pan.x += dx; pan.y += dy; } else { yaw += dx * 0.01; pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.01)); }
    }
    draw();
  };
  const onUp = e => {
    const wasTap = pointers.size === 1 && moved < 6 && e.type === "pointerup";
    pointers.delete(e.pointerId);
    gesture = pointers.size === 2 ? pinchState() : null;
    if (!pointers.size) canvas.classList.remove("dragging");
    if (wasTap && model) { const { x, y } = local(e); const hit = nearest(x, y, 28); selected = hit === selected ? null : hit; draw(); }
  };
  const onWheel = e => { e.preventDefault(); zoom *= Math.exp(-e.deltaY * 0.001); draw(); };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return {
    setModel(next) { model = next; selected = null; draw(); },
    setOptions(next) { options = next; draw(); },
    destroy() {
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}
