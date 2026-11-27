import { test } from "node:test";
import assert from "node:assert/strict";
import { errorSummary } from "../web/ui/error-notice.js";
import { ProcessingScreen } from "../web/ui/processing-screen.js";
import { createModelView, prepareModel } from "../web/ui/model-view.js";

test("scan errors give actionable summaries without exposing technical diagnostics", () => {
  const movement = errorSummary({ message: "Not enough camera movement or shared lights: 19 lights in 444 frames" });
  assert.match(movement, /Move sideways/);
  assert.doesNotMatch(movement, /444 frames/);
  assert.match(errorSummary({ name: "RangeError", message: "allocation failed" }), /memory/i);
  assert.match(errorSummary({ name: "NotAllowedError", message: "Permission denied" }), /browser settings/i);
  assert.match(errorSummary({ message: "Cannot read this video" }), /MP4/);
});

test("processing displays a percentage when progress is known and spins otherwise", () => {
  const known = ProcessingScreen({ fraction: 0.63, status: "Registering cameras" }).props.children[0];
  assert.equal(known.props["aria-valuenow"], 63);
  assert.equal(known.props.children[1].props.children[0], 63);
  assert.doesNotMatch(known.props.class, /spinning/);
  const unknown = ProcessingScreen({}).props.children[0];
  assert.equal(unknown.props["aria-valuenow"], undefined);
  assert.match(unknown.props.class, /spinning/);
});

test("the initial model view centers and fits all lights independently of the first camera", t => {
  let resize;
  const globals = ["ResizeObserver", "devicePixelRatio", "requestAnimationFrame"];
  const previous = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => globals.forEach((name, i) => {
    if (previous[i]) Object.defineProperty(globalThis, name, previous[i]);
    else delete globalThis[name];
  }));
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() { resize(); }
    disconnect() {}
  };
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = callback => callback();
  let points = [], width = 300, height = 200;
  const ctx = {
    setTransform() {}, clearRect() { points = []; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    arc(x, y) { points.push({ x, y }); }, fill() {}, fillText() {},
  };
  const canvas = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }),
    addEventListener() {}, removeEventListener() {},
  };
  const raw = {
    count: 4, cameras: [{ r: [0, 0, 0], t: [0, 0, -20] }],
    points: [
      { index: 0, x: -3, y: 1, z: 2 }, { index: 1, x: 2, y: 5, z: -1 },
      { index: 2, x: 4, y: -2, z: 3 }, { index: 3, x: 1, y: -4, z: -2 },
    ],
  };
  const view = createModelView(canvas);
  view.setModel(prepareModel(raw));
  for (const size of [[300, 200], [200, 400]]) {
    [width, height] = size;
    resize();
    assert.equal(points.length, raw.points.length);
    assert.ok(points.every(p => p.x > 0 && p.x < width && p.y > 0 && p.y < height));
    assert.ok(Math.abs(points.reduce((sum, p) => sum + p.x, 0) / points.length - width / 2) < 1e-8);
    assert.ok(Math.abs(points.reduce((sum, p) => sum + p.y, 0) / points.length - height / 2) < 1e-8);
  }
  view.destroy();
});
