import { test } from "node:test";
import assert from "node:assert/strict";
import { frameColors } from "../web/code.js";
import { consensusCount } from "../web/decode2.js";
import { decodeTracks } from "../web/scan.js";

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
  assert.throws(() => decodeTracks(tracks, { periods: [120] }), /Cannot reliably determine the LED count/);
});
