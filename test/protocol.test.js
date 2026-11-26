import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cv from "@techstark/opencv-js";
import { classifyColor, decodeFrame, StreamDecoder } from "../web/protocol.js";
import { motionField, MultiLightTracker } from "../web/multi-light-tracker.js";
import { BackgroundMotion, detectLights, sampleLight } from "../web/led-tracker.js";

let directory;
let encoder;
before(() => {
  directory = mkdtempSync(join(tmpdir(), "mapper3d-test-"));
  encoder = join(directory, "encode");
  execFileSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Itest/legacy",
    "test/legacy/encode.c", "test/legacy/protocol.c", "-o", encoder]);
});
after(() => { if (directory) rmSync(directory, { recursive: true }); });

function frame(index, count) {
  return execFileSync(encoder, [String(index), String(count)], { encoding: "utf8" }).trim().split(" ").map(Number);
}

test("firmware codes decode across the supported range and contain a unique marker", () => {
  for (const [index, count] of [[0, 1], [0, 100], [99, 100], [1999, 2000], [9999, 10000]]) {
    const symbols = frame(index, count);
    assert.deepEqual(decodeFrame(symbols), { index, count, corrections: 0 });
    const cyclic = [...symbols, ...symbols.slice(0, 3)];
    for (let i = 1; i < symbols.length; i++) {
      assert.notDeepEqual(cyclic.slice(i, i + 4), [5, 5, 5, 4]);
    }
  }
  assert.notEqual(spawnSync(encoder, ["100", "100"]).status, 0);
  assert.notEqual(spawnSync(encoder, ["0", "10001"]).status, 0);
});

test("error correction handles two corrupted codewords and up to four erasures", () => {
  const original = frame(1234, 2000);
  for (let a = 0; a < 12; a++) {
    for (let b = a + 1; b < 12; b++) {
      const damaged = original.slice();
      for (const word of [a, b]) {
        const value = (original[4 + 2 * word] * 6 + original[5 + 2 * word] + 1) % 31;
        damaged[4 + 2 * word] = Math.floor(value / 6);
        damaged[5 + 2 * word] = value % 6;
      }
      assert.equal(decodeFrame(damaged)?.index, 1234);
    }
  }
  const erased = original.slice();
  for (const word of [0, 3, 8, 11]) erased[4 + word * 2] = null;
  assert.deepEqual(decodeFrame(erased), { index: 1234, count: 2000, corrections: 4 });
  erased[4 + 2 * 4] = null;
  assert.equal(decodeFrame(erased), null);
});

test("decodes firmware data value 31 and recovers it from erasure", () => {
  for (let index = 0; index < 20; index++) {
    assert.equal(decodeFrame(frame(index, 20))?.index, index);
  }
  const symbols = frame(9, 20);
  const word = Array.from({ length: 8 }, (_, i) => i)
    .find(i => symbols[4 + i * 2] * 6 + symbols[5 + i * 2] === 31);
  assert.notEqual(word, undefined);
  assert.deepEqual(decodeFrame(symbols), { index: 9, count: 20, corrections: 0 });

  const erased = symbols.slice();
  erased[4 + word * 2] = null;
  assert.equal(decodeFrame(erased)?.index, 9);

  const altered = symbols.slice();
  altered[4 + word * 2] = 0;
  altered[5 + word * 2] = 0;
  assert.deepEqual(decodeFrame(altered), { index: 9, count: 20, corrections: 1 });
});

test("asynchronous camera samples decode within ten seconds at arbitrary phase", () => {
  const symbols = frame(1999, 2000);
  for (let phase = 0; phase < 3360; phase += 67) {
    const decoder = new StreamDecoder();
    let decoded = null;
    for (let time = 0; time < 10000 && !decoded; time += 1000 / 30) {
      if (Math.floor(time / (1000 / 30)) % 19 === 0) continue;
      const color = symbols[Math.floor((time + phase) / 120) % symbols.length];
      decoded = decoder.add(time, color);
    }
    assert.equal(decoded?.index, 1999, `phase ${phase}`);
    assert.equal(decoded?.count, 2000);
  }
});

test("larger strips use the slower timing and survive an unknown start", () => {
  const symbols = frame(9999, 10000);
  const decoder = new StreamDecoder();
  let decoded;
  for (let time = 0; time < 21000 && !decoded; time += 1000 / 30) {
    decoded = decoder.add(time, symbols[Math.floor((time + 5000) / 360) % symbols.length]);
  }
  assert.equal(decoded?.index, 9999);
  assert.equal(decoded?.count, 10000);
});

test("decodes when the recording ends on the last symbol", () => {
  const symbols = frame(137, 2000);
  const decoder = new StreamDecoder();
  let decoded;
  for (let i = 0; i < symbols.length; i++) decoded = decoder.add(i * 120, symbols[i]);
  assert.equal(decoded?.index, 137);
  assert.equal(decoded?.count, 2000);
});

test("prefers the earlier camera sample when samples are equally close", () => {
  const symbols = frame(137, 2000);
  const decoder = new StreamDecoder();
  decoder.add(0, symbols[0]);
  let decoded;
  for (let i = 1; i < symbols.length; i++) {
    decoder.add(i * 120 - 10, symbols[i]);
    decoded = decoder.add(i * 120 + 10, (symbols[i] + 1) % 6);
  }
  assert.deepEqual(decoded, { index: 137, count: 2000, corrections: 0 });
});

test("recovers erased samples from unambiguous nearby colors", () => {
  const symbols = frame(137, 2000);
  const decoder = new StreamDecoder();
  decoder.add(0, symbols[0]);
  let decoded = null;
  for (let i = 1; i < symbols.length; i++) {
    decoder.add(i * 120 - 24, symbols[i]);
    decoded ??= decoder.add(i * 120, null);
    if (i < symbols.length - 1) decoder.add(i * 120 + 24, symbols[i]);
  }
  assert.deepEqual(decoded, { index: 137, count: 2000, corrections: 0 });
});

test("does not recover a marker sample from conflicting nearby colors", () => {
  const symbols = frame(137, 2000);
  const decoder = new StreamDecoder();
  decoder.add(0, symbols[0]);
  let decoded = null;
  for (let i = 1; i < symbols.length; i++) {
    decoded = decoder.add(i * 120 - 24, symbols[i]) ?? decoded;
    decoded = decoder.add(i * 120, i === 2 ? null : symbols[i]) ?? decoded;
    if (i < symbols.length - 1) decoded = decoder.add(i * 120 + 24, i === 2 ? 4 : symbols[i]) ?? decoded;
  }
  assert.equal(decoded, null);
});

test("independent streams reacquire after an extended occlusion", () => {
  const inputs = [
    { symbols: frame(17, 2000), period: 120, phase: 731 },
    { symbols: frame(9999, 10000), period: 360, phase: 2780 },
  ];
  const decoders = inputs.map(() => new StreamDecoder());
  const recovered = inputs.map(() => false);
  for (let time = 0; time < 45000; time += 1000 / 30) {
    for (let i = 0; i < inputs.length; i++) {
      const { symbols, period, phase } = inputs[i];
      const color = time >= 10000 && time < 14000
        ? null : symbols[Math.floor((time + phase) / period) % symbols.length];
      const decoded = decoders[i].add(time, color);
      if (time >= 35000 && decoded?.index === (i === 0 ? 17 : 9999)) recovered[i] = true;
    }
  }
  assert.deepEqual(recovered, [true, true]);
});

test("reacquires labeled LEDs after crossings and occlusion", () => {
  const lights = [2, 7, 9].map(index => ({ index, symbols: frame(index, 20) }));
  const tracker = new MultiLightTracker();
  const identities = new Map(), before = new Set(), after = new Set();
  const earlyTokens = new Map(), lateTokens = new Map();
  let thirdBefore, thirdAfter;
  for (let frameNumber = 0; frameNumber < 600; frameNumber++) {
    const time = frameNumber * 1000 / 30;
    const truth = lights.map((light, i) => ({
      ...light,
      x: i === 0 ? 180 + time / 100 : i === 1 ? 340 - time / 100 : 500,
      y: i === 2 ? 200 : 100,
      color: light.symbols[Math.floor((time + 731) / 120) % 28],
    })).filter(light => light.index !== 9 || time < 10000 || time >= 11000);
    const detections = truth.map(({ x, y, color }) => ({ x, y, color }));
    if (frameNumber % 2) detections.reverse();
    for (const track of tracker.observe(time, detections)) {
      const matches = truth.filter(light => light.x === track.x && light.y === track.y);
      if (matches.length > 1) continue;
      assert.equal(matches.length, 1);
      const index = matches[0].index;
      if (identities.has(track.id)) assert.equal(identities.get(track.id), index, "track switched physical LEDs");
      else identities.set(track.id, index);
      if (time < 7000) earlyTokens.set(index, track.id);
      if (time > 9000 && index !== 9) lateTokens.set(index, track.id);
      if (index === 9 && time < 10000) thirdBefore = track.id;
      if (index === 9 && time >= 11000) thirdAfter = track.id;
      if (track.decoded) {
        assert.equal(track.decoded.index, index);
        assert.equal(track.decoded.count, 20);
        if (time < 7000) before.add(index);
        if (time > 17000) after.add(index);
      }
    }
  }
  assert.deepEqual([...before].sort(), [2, 7, 9]);
  assert.deepEqual([...after].sort(), [2, 7, 9]);
  for (const index of [2, 7]) assert.notEqual(earlyTokens.get(index), lateTokens.get(index));
  assert.notEqual(thirdBefore, thirdAfter, "occluded tracks must not be reconnected without evidence");
});

test("does not reconnect a track across a long frame gap", () => {
  const tracker = new MultiLightTracker();
  const first = tracker.observe(0, [{ x: 100, y: 100, color: 5 }]);
  const resumed = tracker.observe(1001, [{ x: 100, y: 100, color: 5 }]);
  assert.equal(first.length, 1);
  assert.equal(resumed.length, 1);
  assert.notEqual(first[0].id, resumed[0].id);
});

test("keeps a closer track and retains competing hypotheses", () => {
  const tracker = new MultiLightTracker();
  const points = [{ x: 10, y: 30, color: 5 }, { x: 24, y: 30, color: 5 }];
  const initial = tracker.observe(0, points);
  const clear = tracker.observe(33, [{ x: 13, y: 30, color: 5 }]);
  assert.equal(clear.length, 1);
  assert.equal(clear[0].id, initial[0].id);
  tracker.reset();
  const competing = tracker.observe(0, points);
  const ambiguous = tracker.observe(33, [{ x: 17, y: 30, color: 5 }], {
    motion: () => ({ dx: 0, dy: 0 }), sample: () => ({ color: null }),
  });
  for (const track of competing) {
    assert.ok(ambiguous.some(candidate => candidate.id === track.id && candidate.predicted));
  }
});

test("decodes a moving candidate through repeated missing detections", () => {
  const symbols = frame(9, 20), tracker = new MultiLightTracker();
  let id, decoded = null, sampled = 0;
  for (let n = 0; n < 300; n++) {
    const time = n * 1000 / 30, x = 100 + n * 0.5;
    const color = symbols[Math.floor((time + 731) / 120) % 28];
    const detections = n % 7 < 4 && n !== 0 ? [] : [{ x, y: 80, color }];
    const tracks = tracker.observe(time, detections, {
      motion: () => ({ dx: 0.5, dy: 0 }),
      sample: point => {
        sampled++;
        assert.ok(Math.abs(point.x - x) < 0.001);
        assert.equal(point.y, 80);
        return { color };
      },
    });
    assert.equal(tracks.length, 1);
    id ??= tracks[0].id;
    assert.equal(tracks[0].id, id);
    assert.equal(tracks[0].predicted, detections.length === 0);
    decoded ??= tracks[0].decoded;
  }
  assert.ok(sampled > 100);
  assert.equal(decoded?.index, 9);
  assert.equal(decoded?.count, 20);
});

test("keeps multiple checksum-valid candidates with the same LED index", () => {
  const symbols = frame(9, 20), tracker = new MultiLightTracker();
  let candidates = [];
  for (let n = 0; n < 300; n++) {
    const time = n * 1000 / 30;
    const color = symbols[Math.floor((time + 731) / 120) % 28];
    candidates = tracker.observe(time, [{ x: 20, y: 20, color }, { x: 60, y: 20, color }]);
  }
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.decoded?.index === 9 && candidate.decoded.count === 20));
});

test("expires unobserved tracks and retains competing predictions", () => {
  const tracker = new MultiLightTracker({ maxPersistMs: 1000 });
  tracker.observe(0, [{ x: 50, y: 50, color: 5 }]);
  const options = { motion: () => ({ dx: 1, dy: 0 }), sample: () => ({ color: null }) };
  for (let time = 100; time <= 1000; time += 100)
    assert.equal(tracker.observe(time, [], options)[0]?.predicted, true);
  assert.deepEqual(tracker.observe(1100, [], options), []);

  tracker.reset();
  tracker.observe(0, [{ x: 50, y: 50, color: 5 }, { x: 90, y: 50, color: 5 }]);
  const ambiguous = tracker.observe(33, [], {
    motion: point => ({ dx: point.x < 70 ? 15 : -15, dy: 0 }),
    sample: () => ({ color: 5 }),
  });
  assert.equal(ambiguous.length, 2);
  assert.ok(ambiguous.every(track => track.predicted));
});

test("keeps an undecoded hypothesis with usable samples beyond one acquisition cycle", () => {
  const tracker = new MultiLightTracker();
  const initial = tracker.observe(0, [{ x: 50, y: 50, color: 5 }])[0];
  for (let time = 200; time <= 24000; time += 200) {
    const tracks = tracker.observe(time, [], { motion: () => null, sample: () => ({ color: 0 }) });
    assert.equal(tracks[0]?.id, initial.id);
    assert.equal(tracks[0]?.predicted, true);
  }
});

test("samples a moving weak light using measured background motion", async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const width = 160, height = 120, symbols = frame(9, 20);
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const background = new Uint8Array(width * height);
  let state = 12345;
  for (let i = 0; i < background.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    background[i] = 20 + (state >>> 26);
  }
  const palette = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]];
  const tracker = new MultiLightTracker(), estimator = new BackgroundMotion(cv);
  let id, decoded = null, predictedFrames = 0;
  try {
    for (let n = 0; n < 300; n++) {
      const time = n * 1000 / 30, shift = Math.floor(n / 5), x = 40 + shift, y = 55;
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          const shade = px >= shift ? background[py * width + px - shift] : 30;
          image.data.set([shade, shade, shade, 255], (py * width + px) * 4);
        }
      }
      const weak = n !== 0 && n % 7 < 4;
      const color = palette[symbols[Math.floor((time + 731) / 120) % 28]];
      for (let py = y - 3; py <= y + 3; py++) {
        for (let px = x - 3; px <= x + 3; px++) {
          if (Math.hypot(px - x, py - y) <= 3)
            image.data.set([...color.map(channel => channel ? (weak ? 95 : 255) : 0), 255],
              (py * width + px) * 4);
        }
      }
      const flow = estimator.observe(image, tracker.tracks);
      const detections = detectLights(cv, image);
      const motion = motionField(flow);
      const previous = tracker.tracks[0];
      const movement = previous ? motion(previous) : null;
      const tracks = tracker.observe(time, detections, {
        motion,
        sample: point => sampleLight(image, point),
      });
      assert.equal(tracks.length, 1, `tracking lost at frame ${n}; flow ${flow.length}; motion ${JSON.stringify(movement)}; detections ${detections.length}; sample ${JSON.stringify(flow.slice(0, 5))}; previous ${JSON.stringify(previous && { x: previous.x, y: previous.y, lastSeen: previous.lastSeen })}`);
      id ??= tracks[0].id;
      assert.equal(tracks[0].id, id, `track changed at frame ${n}`);
      assert.ok(Math.hypot(tracks[0].x - x, tracks[0].y - y) <= 4);
      if (tracks[0].predicted) predictedFrames++;
      decoded ??= tracks[0].decoded;
    }
    assert.ok(predictedFrames > 100);
    assert.equal(decoded?.index, 9);
    assert.equal(decoded?.count, 20);
  } finally {
    estimator.reset();
  }
});

test("detects and decodes several independent lights from synthetic images", async () => {
  await new Promise((resolve, reject) => cv.then(() => resolve(), reject));
  const lights = [2, 7, 9].map((index, i) => ({ index, x: 25 + i * 45, y: 35, symbols: frame(index, 20) }));
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
  const image = { width: 140, height: 70, data: new Uint8ClampedArray(140 * 70 * 4) };
  const tracker = new MultiLightTracker();
  const decoded = new Set();
  for (let n = 0; n < 300; n++) {
    const time = n * 1000 / 30;
    for (let i = 0; i < image.data.length; i += 4) image.data.set([60, 60, 60, 255], i);
    for (const light of lights) {
      const color = palette[light.symbols[Math.floor((time + 731) / 120) % 28]];
      for (let y = light.y - 3; y <= light.y + 3; y++) {
        for (let x = light.x - 3; x <= light.x + 3; x++) {
          if (Math.hypot(x - light.x, y - light.y) <= 3)
            image.data.set([...color, 255], (y * image.width + x) * 4);
        }
      }
    }
    for (const track of tracker.observe(time, detectLights(cv, image))) {
      const light = lights.find(point => Math.hypot(point.x - track.x, point.y - track.y) <= 4);
      assert.ok(light, "unexpected synthetic detection");
      if (track.decoded) {
        assert.equal(track.decoded.index, light.index);
        decoded.add(light.index);
      }
    }
  }
  assert.deepEqual([...decoded].sort(), [2, 7, 9]);
});

test("classifies the six colors and rejects dark and white samples", () => {
  for (const [index, rgb] of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]].entries())
    assert.equal(classifyColor(...rgb), index);
  assert.equal(classifyColor(0, 0, 0), null);
  assert.equal(classifyColor(255, 255, 255), null);
});

test("decodes a generated H.264 video file", () => {
  const filename = join(directory, "beacon.mp4");
  const symbols = frame(137, 2000);
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
  const raw = Buffer.alloc(300 * 16 * 16 * 3);
  for (let frameNumber = 0; frameNumber < 300; frameNumber++) {
    const color = palette[symbols[Math.floor((frameNumber * 1000 / 30 + 1370) / 120) % symbols.length]];
    for (let pixel = 0; pixel < 16 * 16; pixel++)
      for (let channel = 0; channel < 3; channel++)
        raw[(frameNumber * 16 * 16 + pixel) * 3 + channel] = color[channel];
  }
  execFileSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "16x16",
    "-framerate", "30", "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", filename], { input: raw });
  const decoded = execFileSync("ffmpeg", ["-v", "error", "-i", filename, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: raw.length * 2 });
  const stream = new StreamDecoder();
  let result = null;
  for (let i = 0; i < decoded.length / (16 * 16 * 3) && !result; i++) {
    const offset = i * 16 * 16 * 3;
    result = stream.add(i * 1000 / 30, classifyColor(decoded[offset], decoded[offset + 1], decoded[offset + 2]));
  }
  assert.equal(result?.index, 137);
  assert.equal(result?.count, 2000);
});
