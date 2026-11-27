import { test } from "node:test";
import assert from "node:assert/strict";
import { videoFrames } from "../web/capture.js";

test("live capture analyzes full-sized frames without changing their timestamp", async () => {
  const originalDocument = globalThis.document;
  let callback, drawn;
  const canvas = { getContext: () => ({
    drawImage: (...args) => { drawn = args; },
    getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
  }) };
  const video = {
    videoWidth: 9, videoHeight: 7,
    requestVideoFrameCallback(fn) { callback = fn; },
    addEventListener() {},
    async play() { callback(1000, { captureTime: 123 }); },
    pause() {},
  };
  try {
    globalThis.document = { createElement: () => canvas };
    const frames = videoFrames(video, { live: true });
    const { value: frame } = await frames.next();
    assert.deepEqual([canvas.width, canvas.height, frame.width, frame.height, frame.time], [9, 7, 9, 7, 123]);
    assert.deepEqual(drawn, [video, 0, 0]);
    assert.equal(frame.data.length, 9 * 7 * 4);
    await frames.return();
  } finally {
    globalThis.document = originalDocument;
  }
});
