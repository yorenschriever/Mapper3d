import { test } from "node:test";
import assert from "node:assert/strict";
import { errorSummary } from "../web/ui/error-notice.js";
import { ProcessingScreen } from "../web/ui/processing-screen.js";
import { createModelView, prepareModel } from "../web/ui/model-view.js";
import { createExposureControls, ExposureControl, openRearCamera } from "../web/ui/camera-screen.js";

test("the browser selects the rear camera before resolution and frame-rate preferences are applied", async () => {
  const calls = [];
  const track = { async applyConstraints(constraints) { calls.push(["track", constraints]); } };
  const stream = { getVideoTracks: () => [track] };
  const mediaDevices = { async getUserMedia(constraints) { calls.push(["camera", constraints]); return stream; } };
  assert.equal(await openRearCamera(mediaDevices), stream);
  assert.deepEqual(calls, [
    ["camera", { video: { facingMode: "environment" }, audio: false }],
    ["track", { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }],
  ]);
});

test("a chosen camera is requested by its exact device ID", async () => {
  let constraints;
  const stream = { getVideoTracks: () => [{ applyConstraints: async () => {} }] };
  await openRearCamera({ getUserMedia: async value => { constraints = value; return stream; } }, "camera-2");
  assert.deepEqual(constraints, { video: { deviceId: { exact: "camera-2" } }, audio: false });
});

test("the selected camera stays usable when optional capture preferences fail", async t => {
  const warn = t.mock.method(console, "warn", () => {});
  const stream = { getVideoTracks: () => [{ async applyConstraints() { throw new Error("unsupported"); } }] };
  assert.equal(await openRearCamera({ getUserMedia: async () => stream }), stream);
  assert.equal(warn.mock.callCount(), 1);
});

test("exposure starts in manual at 8ms and preserves manual settings", async () => {
  const calls = [], changes = [], errors = [];
  const settings = { exposureMode: "continuous", exposureTime: 50, iso: 100, colorTemperature: 4000 };
  const track = {
    getCapabilities: () => ({
      exposureMode: ["continuous", "manual"], exposureCompensation: { min: -5, max: 2, step: 0.1 },
      exposureTime: { min: 5, max: 500, step: 5 }, iso: { min: 100, max: 800, step: 100 },
      whiteBalanceMode: ["continuous", "manual"],
    }),
    getSettings: () => ({ ...settings }),
    async applyConstraints({ advanced: [value] }) { calls.push(value); Object.assign(settings, value); },
  };
  const controls = createExposureControls(track, state => changes.push(state), error => errors.push(error));
  await controls.setMode("manual");
  assert.deepEqual(calls.slice(0, 3), [
    { exposureMode: "manual" },
    { exposureMode: "manual", exposureTime: 80, iso: 100 },
    { exposureMode: "manual", exposureTime: 80, iso: 100 },
  ]);
  assert.equal(settings.exposureTime, 80);
  assert.equal(changes[0].mode, "auto");
  assert.equal(changes[0].value, -5);
  assert.equal(changes.at(-1).timeRange.max, 165);
  await controls.setTime(30);
  await controls.unlock();
  assert.deepEqual(calls.at(-1), { exposureMode: "manual", exposureTime: 30, iso: 100 });
  await controls.setMode("auto");
  await controls.set(-1);
  assert.equal(changes.at(-1).mode, "auto");
  await controls.setMode("manual");
  assert.equal(settings.exposureTime, 30);
  await controls.setMode("auto");
  await controls.lock();
  assert.deepEqual(calls.at(-1), { exposureMode: "manual", exposureTime: 30, iso: 100 });
  await controls.unlock();
  assert.deepEqual(calls.at(-1), { exposureMode: "continuous", exposureCompensation: -1 });
  assert.deepEqual(errors, []);
});

test("failure to apply minimum compensation is reported", async () => {
  const errors = [];
  const track = {
    getCapabilities: () => ({ exposureMode: ["continuous"], exposureCompensation: { min: -4, max: 2, step: 0.1 } }),
    getSettings: () => ({ exposureMode: "continuous", exposureCompensation: 0 }),
    applyConstraints: async () => {},
  };
  const controls = createExposureControls(track, () => {}, error => errors.push(error), { wait: async () => {} });
  await controls.set(-4);
  assert.match(errors.at(-1).message, /exposure compensation/);
});

test("white balance stays at 6000 K through exposure and recording changes", async () => {
  const calls = [], errors = [], states = [];
  const settings = { whiteBalanceMode: "continuous", colorTemperature: 4000, exposureMode: "continuous", exposureTime: 50 };
  const track = {
    getCapabilities: () => ({
      whiteBalanceMode: ["continuous", "manual"], colorTemperature: { min: 2500, max: 6500, step: 100 },
      exposureMode: ["continuous", "manual"], exposureTime: { min: 5, max: 150, step: 5 },
      exposureCompensation: { min: -2, max: 2 },
    }),
    getSettings: () => ({ ...settings }),
    async applyConstraints({ advanced: [value] }) { calls.push(value); Object.assign(settings, value); },
  };
  const controls = createExposureControls(track, state => states.push(state), error => errors.push(error));
  await controls.setMode("auto");
  await controls.setMode("manual");
  await controls.lock();
  await controls.unlock();
  assert.ok(calls.length > 4);
  assert.ok(calls.every(call => call.whiteBalanceMode === "manual" && call.colorTemperature === 6000));
  assert.equal(settings.colorTemperature, 6000);
  assert.equal(states.at(-1).whiteBalanceWarning, null);
  assert.deepEqual(errors, []);
});

test("unavailable or ignored 6000 K white balance is reported", async t => {
  t.mock.method(console, "warn", () => {});
  for (const [capabilities, applyConstraints] of [
    [{ whiteBalanceMode: ["continuous"] }, async () => {}],
    [{ whiteBalanceMode: ["manual"], colorTemperature: { min: 2500, max: 5500, step: 100 } }, async () => {}],
    [{ whiteBalanceMode: ["manual"], colorTemperature: { min: 2500, max: 6500, step: 300 } }, async () => {}],
    [{ whiteBalanceMode: ["manual"], colorTemperature: { min: 2500, max: 6500, step: 100 } }, async () => {}],
    [{ whiteBalanceMode: ["manual"], colorTemperature: { min: 2500, max: 6500, step: 100 } }, async () => { throw new Error("rejected"); }],
  ]) {
    const states = [], errors = [];
    const track = {
      getCapabilities: () => capabilities,
      getSettings: () => ({ whiteBalanceMode: "continuous", colorTemperature: 4000 }),
      applyConstraints,
    };
    const controls = createExposureControls(track, state => states.push(state), error => errors.push(error), { wait: async () => {} });
    await controls.lock();
    assert.match(states.at(-1).whiteBalanceWarning, /6000 K/);
    assert.equal(ExposureControl({ exposure: states.at(-1) }).props.children.at(-1).props.role, "status");
    assert.deepEqual(errors, []);
  }
});

test("white balance failures do not block exposure and remain visible after exposure changes", async t => {
  t.mock.method(console, "warn", () => {});
  const states = [], errors = [];
  const settings = { whiteBalanceMode: "continuous", colorTemperature: 4000, exposureMode: "continuous" };
  const track = {
    getCapabilities: () => ({
      whiteBalanceMode: ["manual"], colorTemperature: { min: 2500, max: 6500, step: 100 },
      exposureMode: ["manual"], exposureTime: { min: 5, max: 150, step: 5 },
    }),
    getSettings: () => ({ ...settings }),
    async applyConstraints({ advanced: [value] }) {
      if (value.colorTemperature) throw new Error("rejected");
      Object.assign(settings, value);
    },
  };
  const controls = createExposureControls(track, state => states.push(state), error => errors.push(error), { wait: async () => {} });
  await controls.setTime(60);
  assert.equal(settings.exposureTime, 60);
  assert.match(states.at(-1).whiteBalanceWarning, /6000 K/);
  assert.deepEqual(errors, []);
});

test("white balance changes after initialization are reported", async () => {
  const states = [], errors = [];
  const settings = { whiteBalanceMode: "continuous", colorTemperature: 4000 };
  const track = {
    getCapabilities: () => ({
      whiteBalanceMode: ["manual"], colorTemperature: { min: 2500, max: 6500, step: 100 },
      exposureMode: ["manual"], exposureTime: { min: 5, max: 150 },
    }),
    getSettings: () => ({ ...settings }),
    async applyConstraints({ advanced: [value] }) {
      Object.assign(settings, value);
      if (value.exposureTime) settings.whiteBalanceMode = "continuous";
    },
  };
  const controls = createExposureControls(track, state => states.push(state), error => errors.push(error), { wait: async () => {} });
  await controls.lock();
  assert.match(states.at(-1).whiteBalanceWarning, /6000 K/);
  assert.deepEqual(errors, []);
});

test("manual exposure range respects 1/60 second, camera limits and steps", async () => {
  const states = [], errors = [];
  const makeTrack = exposureTime => ({
    getCapabilities: () => ({ exposureTime, exposureMode: ["manual"] }),
    applyConstraints: async () => {},
  });
  let controls = createExposureControls(makeTrack({ min: 1, max: 500 }), state => states.push(state), error => errors.push(error));
  await controls.setTime(10000 / 60);
  assert.equal(states.at(-1).timeRange.max, 10000 / 60);
  await controls.setTime(10000 / 60 + 1);
  assert.match(errors.at(-1).message, /outside the supported range/);
  controls = createExposureControls(makeTrack({ min: 1, max: 50, step: 7 }), state => states.push(state), error => errors.push(error));
  await controls.setTime(50);
  assert.equal(states.at(-1).timeRange.max, 50);
  createExposureControls(makeTrack({ min: 170, max: 500, step: 10 }), state => states.push(state), error => errors.push(error));
  assert.equal(states.at(-1).timeRange, null);
});

test("initial exposure respects camera limits and steps", async () => {
  for (const [range, expected] of [
    [{ min: 90, max: 150, step: 10 }, 90],
    [{ min: 5, max: 50, step: 5 }, 50],
    [{ min: 5, max: 150, step: 10 }, 85],
  ]) {
    const calls = [], errors = [];
    const track = {
      getCapabilities: () => ({ exposureMode: ["manual"], exposureTime: range }),
      async applyConstraints({ advanced: [value] }) { calls.push(value); },
    };
    const controls = createExposureControls(track, () => {}, error => errors.push(error));
    await controls.lock();
    assert.equal(calls[1].exposureTime, expected);
    assert.deepEqual(errors, []);
  }
});

test("exposure control shows only the slider for the selected mode", () => {
  const modes = [];
  const exposure = {
    range: { min: -3, max: 3, step: 1 }, timeRange: { min: 5, max: 165, step: 5 },
    autoAvailable: true, mode: "manual", value: -2, time: 5,
    set() {}, setTime() {}, setMode: mode => modes.push(mode),
  };
  const row = mode => ExposureControl({ exposure: { ...exposure, mode } }).props.children[0].props.children;
  const slider = mode => row(mode)[1].props.children.find(child => child?.type === "input");
  assert.equal(slider("manual").props["aria-label"], "Exposure time");
  assert.equal(slider("manual").props.max, 165);
  assert.equal(slider("auto").props["aria-label"], "Exposure compensation");
  row("auto")[0].props.onClick();
  row("manual")[0].props.onClick();
  assert.deepEqual(modes, ["manual", "auto"]);
});

test("the camera picker remains available when exposure controls are unsupported", () => {
  const control = ExposureControl({ exposure: {}, devices: [{ deviceId: "main", label: "Main" }], selectedId: "main" });
  const picker = control.props.children[0].props.children[2];
  assert.equal(picker.props.children[1].props["aria-label"], "Camera");
  assert.equal(picker.props.children[1].props.value, "main");
});

test("exposure time is unavailable without manual mode, and rejected settings are reported", async () => {
  const changes = [], errors = [];
  const unsupported = {
    getCapabilities: () => ({ exposureTime: { min: 1, max: 10 }, exposureMode: ["continuous"] }),
    applyConstraints: async () => {},
  };
  createExposureControls(unsupported, value => changes.push(value), error => errors.push(error));
  assert.equal(changes[0].timeRange, null);
  const track = {
    getCapabilities: () => ({ exposureTime: { min: 1, max: 10 }, exposureMode: ["manual"] }),
    getSettings: () => ({ exposureMode: "continuous" }),
    applyConstraints: async () => {},
  };
  const controls = createExposureControls(track, () => {}, error => errors.push(error), { wait: async () => {} });
  await controls.setTime(2);
  assert.match(errors.at(-1).message, /manual exposure/);
  track.getSettings = () => ({ exposureMode: "manual", exposureTime: 9 });
  await controls.setTime(2);
  assert.match(errors.at(-1).message, /requested exposure time/);
});

test("manual exposure switches modes before setting the time", async () => {
  const states = [], errors = [], calls = [];
  const settings = { exposureMode: "continuous", exposureTime: 50 };
  let modeEnabled = false;
  const track = {
    getCapabilities: () => ({ exposureMode: ["continuous", "manual"], exposureCompensation: { min: -3, max: 3 }, exposureTime: { min: 5, max: 100 } }),
    getSettings: () => ({ ...settings }),
    async applyConstraints({ advanced: [value] }) {
      calls.push(value);
      if (value.exposureMode === "manual" && value.exposureTime === undefined) modeEnabled = true;
      if (value.exposureMode !== "manual" || modeEnabled) Object.assign(settings, value);
    },
  };
  const controls = createExposureControls(track, value => states.push(value), error => errors.push(error), { wait: async () => {} });
  await controls.setMode("manual");
  assert.deepEqual(calls.slice(0, 3), [
    { exposureMode: "manual" },
    { exposureMode: "manual", exposureTime: 80 },
    { exposureMode: "manual", exposureTime: 80 },
  ]);
  assert.equal(states.at(-1).mode, "manual");
  assert.equal(settings.exposureTime, 80);
  assert.deepEqual(errors, []);
});

test("manual exposure accepts settings that take time to settle", async () => {
  const states = [], errors = [], calls = [];
  let settings = { exposureMode: "continuous", exposureTime: 50 }, requested;
  const track = {
    getCapabilities: () => ({ exposureMode: ["manual"], exposureTime: { min: 5, max: 100 } }),
    getSettings: () => settings,
    async applyConstraints({ advanced: [value] }) { calls.push(value); requested = value; },
  };
  const controls = createExposureControls(track, value => states.push(value), error => errors.push(error), {
    wait: async () => { settings = { ...settings, ...requested }; },
  });
  await controls.setTime(10);
  assert.equal(states.at(-1).time, 10);
  assert.equal(calls.length, 3);
  assert.deepEqual(errors, []);
});

test("Chromium Android mode 'none' allows time control only when the time matches", async () => {
  const states = [], errors = [];
  const settings = { exposureMode: "continuous", exposureTime: 50 };
  const track = {
    getCapabilities: () => ({ exposureMode: ["continuous", "manual"], exposureCompensation: { min: -3, max: 3 }, exposureTime: { min: 5, max: 100 } }),
    getSettings: () => ({ ...settings }),
    async applyConstraints({ advanced: [value] }) {
      if (value.exposureMode === "manual") settings.exposureMode = "none";
      else if (value.exposureMode) settings.exposureMode = value.exposureMode;
      if (value.exposureTime !== undefined) settings.exposureTime = value.exposureTime;
    },
  };
  const controls = createExposureControls(track, value => states.push(value), error => errors.push(error), { wait: async () => {}, androidChromium: true });
  await controls.setTime(30);
  assert.equal(states.at(-1).mode, "manual");
  assert.equal(states.at(-1).time, 30);
  assert.equal(states.at(-1).warning, null);
  assert.deepEqual(errors, []);
});

test("Chromium Android uses the first positive step when the reported minimum is zero", async () => {
  const states = [], errors = [], calls = [];
  const track = {
    getCapabilities: () => ({ exposureMode: ["manual"], exposureTime: { min: 0, max: 100, step: 0.1 } }),
    async applyConstraints({ advanced: [value] }) { calls.push(value); },
  };
  const controls = createExposureControls(track, value => states.push(value), error => errors.push(error), { androidChromium: true });
  await controls.lock();
  assert.equal(states.at(-1).timeRange.min, 0.1);
  assert.ok(Math.abs(states.at(-1).time - 80) < 1e-6);
  assert.ok(Math.abs(calls[1].exposureTime - 80) < 1e-6);
  assert.deepEqual(errors, []);
});

test("an ignored manual request falls back to auto with a visible warning", async () => {
  const states = [], errors = [], calls = [];
  const settings = { exposureMode: "continuous", exposureTime: 50 };
  const track = {
    getCapabilities: () => ({ exposureMode: ["continuous", "manual"], exposureCompensation: { min: -3, max: 3 }, exposureTime: { min: 5, max: 100 } }),
    getSettings: () => ({ ...settings }),
    async applyConstraints({ advanced: [value] }) {
      calls.push(value);
      if (value.exposureMode === "continuous") Object.assign(settings, value);
    },
  };
  const controls = createExposureControls(track, value => states.push(value), error => errors.push(error), { wait: async () => {} });
  await controls.setMode("manual");
  const state = states.at(-1);
  assert.equal(state.mode, "auto");
  assert.match(state.warning, /Auto exposure is active/);
  assert.equal(ExposureControl({ exposure: state }).props.children.at(-1).props.role, "status");
  assert.equal(calls.at(-1).exposureMode, "continuous");
  assert.deepEqual(errors, []);
});

test("scan errors give actionable summaries without exposing technical diagnostics", () => {
  const movement = errorSummary({ message: "Not enough camera movement or shared lights: 19 lights in 444 frames" });
  assert.match(movement, /Move sideways/);
  assert.doesNotMatch(movement, /444 frames/);
  assert.match(errorSummary({ name: "RangeError", message: "allocation failed" }), /memory/i);
  assert.match(errorSummary({ name: "NotAllowedError", message: "Permission denied" }), /browser settings/i);
  assert.match(errorSummary({ message: "Cannot set camera exposure: rejected" }), /camera exposure/i);
  assert.match(errorSummary({ message: "Cannot read this video" }), /MP4/);
  assert.match(errorSummary({ message: "Unexpected error" }), /open Details/);
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
