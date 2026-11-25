import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyColor, decodeFrame, StreamDecoder } from "../web/protocol.js";

let directory;
let encoder;
before(() => {
  directory = mkdtempSync(join(tmpdir(), "mapper3d-test-"));
  encoder = join(directory, "encode");
  execFileSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Ifirmware/main",
    "test/encode.c", "firmware/main/protocol.c", "-o", encoder]);
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
