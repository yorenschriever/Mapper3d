import { test } from "node:test";
import assert from "node:assert/strict";
import { frameColors } from "../web/code.js";
import { MAX_RETAINED_TRACKS, MAX_SPOTS_PER_FRAME, SPOT_SEPARATION } from "../web/config.js";
import { consensusCount } from "../web/decode2.js";
import { decodeTracks, PIPELINE_VERSION, scanMoving, trackFrames } from "../web/scan.js";

function evidence(index, count, weight = 10) {
  const likelihoods = frameColors(index, count).map(color => Array.from({ length: 5 }, (_, c) => c === color ? 0 : -weight));
  return { likelihoods, result: { index, accepted: true } };
}

function consensus(items) {
  return consensusCount(items.map(x => x.likelihoods), items.map(x => x.result));
}

test("count consensus gives each LED one vote despite overconfident duplicate tracks", () => {
  const items = [evidence(0, 20), evidence(1, 20), evidence(2, 20), evidence(3, 20)];
  for (let i = 0; i < 12; i++) items.push(evidence(4, 6158, 100));
  assert.equal(consensus(items).count, 20);
});

test("count consensus rejects ties, insufficient independent evidence and uninformative slots", () => {
  assert.equal(consensus([]).count, null);
  assert.equal(consensus([evidence(0, 20), evidence(1, 21)]).count, null);
  assert.equal(consensus([evidence(0, 20), evidence(0, 21), evidence(1, 20), evidence(2, 21)]).count, null);
  assert.equal(consensus(Array.from({ length: 5 }, () => evidence(0, 20))).count, null);
  const blank = evidence(0, 1);
  blank.likelihoods = blank.likelihoods.map(() => [0, 0, 0, 0, 0]);
  assert.equal(consensus([blank]).count, null);
});

test("a single LED can establish its count with strongly supported count slots", () => {
  assert.equal(consensus([evidence(0, 1)]).count, 1);
});

test("reports uncertainty when indices decode but count slots are missing", () => {
  const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.707, .707, 0], [.707, 0, .707]];
  const tracks = Array.from({ length: 8 }, (_, index) => {
    const word = frameColors(index, 20), samples = [];
    for (let time = 0; time < 120 * 28 * 3; time += 30) {
      const slot = Math.floor(time / 120) % 28, color = colors[word[slot]];
      samples.push({ time, x: index * 10, y: 100, features: slot >= 20 ? null : [...color, 0, ...color, ...color] });
    }
    return { samples };
  });
  assert.throws(() => decodeTracks(tracks), /Cannot reliably determine the LED count/);
});

test("decodes a count above 2000 using the fixed 120 ms period", () => {
  const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.707, .707, 0], [.707, 0, .707]];
  const tracks = Array.from({ length: 8 }, (_, index) => {
    const word = frameColors(index, 2001), samples = [];
    for (let time = 0; time < 120 * 28 * 3; time += 30) {
      const color = colors[word[Math.floor(time / 120) % word.length]];
      samples.push({ time, x: index * 10, y: 100, features: [...color, 0, ...color, ...color] });
    }
    return { samples };
  });
  const result = decodeTracks(tracks);
  assert.equal(result.count, 2001);
  assert.equal(result.period, 120);
  assert.deepEqual([...new Set(result.tracks.map(t => t.index))].sort((a, b) => a - b),
    Array.from({ length: 8 }, (_, i) => i));
});

test("calibrates on verified repeating tracks when short clutter overwhelms the initial calibration", () => {
  const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.707, .707, 0], [.707, 0, .707]];
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const tracks = [];
  for (let i = 0; i < 60; i++) {
    const samples = [];
    for (let time = 0; time < 2400; time += 20) {
      const color = colors[Math.floor(random() * colors.length)];
      samples.push({ time, x: i, y: 0, features: [...color, 0, ...color, ...color] });
    }
    tracks.push({ samples });
  }
  for (let index = 0; index < 10; index++) {
    const word = frameColors(index, 10), samples = [];
    for (let time = 0; time < 7000; time += 40) {
      const color = colors[word[Math.floor(time / 120) % word.length]];
      samples.push({ time, x: index, y: 0, features: [...color, 0, ...color, ...color] });
    }
    tracks.push({ samples });
  }
  const result = decodeTracks(tracks);
  assert.equal(result.count, 10);
  assert.equal(result.period, 120);
  assert.deepEqual([...new Set(result.tracks.map(t => t.index))].sort((a, b) => a - b),
    Array.from({ length: 10 }, (_, i) => i));
});

test("retains the configured number of tracks and supports an explicit override", async () => {
  const spots = Array.from({ length: 1001 }, (_, x) => ({ x: x * 20, y: 0, features: [1] }));
  const options = { minSamples: 1, analyze: () => spots };
  assert.equal((await trackFrames([{ time: 0 }], options)).length, Math.min(spots.length, MAX_RETAINED_TRACKS));
  assert.equal((await trackFrames([{ time: 0 }], { ...options, maxTracks: 600 })).length, 600);
});

test("does not reuse a track cache created without the configured spot separation", async () => {
  const oldKey = `recording:v${PIPELINE_VERSION}:${MAX_RETAINED_TRACKS}:30:${MAX_SPOTS_PER_FRAME}`;
  const entries = new Map([[oldKey, [{ samples: [] }]]]);
  const cache = {
    get: async key => entries.get(key),
    set: async (key, value) => entries.set(key, value),
  };
  assert.deepEqual(await scanMoving([], { cache, cacheKey: "recording" }), { count: 0, period: 0, tracks: [] });
  assert.ok(entries.has(`${oldKey}:${SPOT_SEPARATION}`));
});
