import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLOR_COUNT, FRAME_SLOTS, frameColors, indexColors, MAX_VALUE } from "../web/code.js";

let directory, encoder;
before(() => {
  directory = mkdtempSync(join(tmpdir(), "mapper3d-code-"));
  encoder = join(directory, "encode");
  execFileSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Ifirmware/main",
    "test/encode.c", "firmware/main/protocol.c", "-o", encoder]);
});
after(() => { if (directory) rmSync(directory, { recursive: true }); });

test("firmware and browser encoders produce the same frame", () => {
  for (const [index, count] of [[0, 1], [0, 20], [19, 20], [1999, 2000], [2000, 2001], [9999, 10000]]) {
    const symbols = execFileSync(encoder, [String(index), String(count)], { encoding: "utf8" }).trim().split(" ").map(Number);
    assert.equal(symbols.length, FRAME_SLOTS);
    assert.deepEqual(symbols, frameColors(index, count));
  }
});

test("firmware rejects an invalid index or count", () => {
  for (const args of [["20", "20"], ["0", "0"], ["0", "10001"], ["-1", "5"]]) {
    assert.throws(() => execFileSync(encoder, args, { stdio: "ignore" }));
  }
});

test("index words of different LEDs differ in at least eight of ten symbols", () => {
  const words = Array.from({ length: 2500 }, (_, i) => indexColors(i * 4 + 1)).map(colors =>
    Array.from({ length: 10 }, (_, s) => colors[2 * s] * COLOR_COUNT + colors[2 * s + 1]));
  for (const word of words) assert.ok(word.every(value => value < 23));
  let minimum = 10;
  for (let a = 0; a < words.length; a += 7) {
    for (let b = a + 1; b < words.length; b++) {
      let distance = 0;
      for (let s = 0; s < 10; s++) if (words[a][s] !== words[b][s]) distance++;
      minimum = Math.min(minimum, distance);
    }
  }
  assert.equal(minimum, 8);
  assert.ok(MAX_VALUE >= 10000);
});

test("every color is used and low indices are not constant", () => {
  const used = new Set();
  for (let i = 0; i < 20; i++) frameColors(i, 20).forEach(c => used.add(c));
  assert.equal(used.size, COLOR_COUNT);
  assert.ok(new Set(frameColors(0, 20).slice(0, 20)).size > 2);
});
