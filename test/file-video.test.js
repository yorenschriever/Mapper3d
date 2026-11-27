import { test } from "node:test";
import assert from "node:assert/strict";
import { MP4Box } from "../web/vendor/mp4box.js";
import { openVideoFile, readVideoSamples } from "../web/file-video.js";

function source(chunks) {
  let cancelled = false;
  return {
    file: { stream: () => new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(Uint8Array.from(chunks.shift()));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }) },
    wasCancelled: () => cancelled,
  };
}

test("reads samples across chunks, skipping other file data", async () => {
  const { file } = source([[0, 1, 2], [3, 4], [5, 6, 7, 8], [9, 10]]);
  const samples = [{ offset: 1, size: 5, number: 0 }, { offset: 8, size: 2, number: 1 }];
  const result = [];
  for await (const bytes of readVideoSamples(file, samples)) result.push([...bytes]);
  assert.deepEqual(result, [[1, 2, 3, 4, 5], [8, 9]]);
});

test("reports truncated and out-of-order samples", async () => {
  const collect = async (file, samples) => {
    for await (const _ of readVideoSamples(file, samples)) { /* consume */ }
  };
  await assert.rejects(collect(source([[0, 1]]).file, [{ offset: 0, size: 3, number: 0 }]), /ended while reading frame 1/);
  await assert.rejects(collect(source([[0, 1, 2]]).file, [
    { offset: 1, size: 1, number: 0 }, { offset: 0, size: 1, number: 1 },
  ]), /not in sequential file order/);
});

test("closing the iterator cancels the file stream", async () => {
  const input = source([[0, 1, 2], [3, 4, 5]]);
  const reader = readVideoSamples(input.file, [{ offset: 0, size: 1, number: 0 }]);
  await reader.next();
  await reader.return();
  assert.equal(input.wasCancelled(), true);
});

test("preserves full resolution and presentation coordinates of rotated video frames", async () => {
  const createFile = MP4Box.createFile;
  const originalDecoder = globalThis.VideoDecoder, originalChunk = globalThis.EncodedVideoChunk;
  const transforms = [], draws = [];
  let closed = false;
  try {
    const sample = { offset: 0, size: 1, number: 0, description_index: 0, is_sync: true, cts: 100, duration: 40, timescale: 1000 };
    const trak = {
      tkhd: { matrix: [0, 65536, 0, -65536, 0] },
      mdia: { minf: { stbl: { stsd: { entries: [{}] } } } },
      samples: [sample],
    };
    MP4Box.createFile = () => ({
      appendBuffer(data) {
        this.onReady({ videoTracks: [{ id: 1, codec: "test", video: { width: 8, height: 4 }, duration: 1, timescale: 1 }] });
        return data.byteLength;
      },
      getTrackById: () => trak,
    });
    globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
    globalThis.VideoDecoder = class {
      static async isConfigSupported() { return { supported: true }; }
      constructor({ output }) { this.output = output; this.state = "configured"; this.decodeQueueSize = 0; }
      configure() {}
      decode(chunk) { this.output({ timestamp: chunk.timestamp, close() { closed = true; } }); }
      close() { this.state = "closed"; }
    };
    const file = new Blob([Uint8Array.of(42)]);
    const video = await openVideoFile(file);
    const canvas = { getContext: () => ({
      setTransform: (...args) => transforms.push(args),
      drawImage: (...args) => draws.push(args.slice(1)),
      resetTransform() {},
      getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    }) };
    const frames = video.frames(canvas);
    const { value: frame } = await frames.next();
    assert.deepEqual([video.width, video.height, canvas.width, canvas.height], [4, 8, 4, 8]);
    assert.deepEqual([frame.width, frame.height, frame.data.length, frame.time], [4, 8, 128, 100]);
    assert.deepEqual(transforms[0], [0, 1, -1, 0, 4, -0]);
    assert.deepEqual(draws[0], [0, 0, 8, 4]);
    await frames.return();
    assert.equal(closed, true);
  } finally {
    MP4Box.createFile = createFile;
    globalThis.VideoDecoder = originalDecoder;
    globalThis.EncodedVideoChunk = originalChunk;
  }
});
