import { test } from "node:test";
import assert from "node:assert/strict";
import { readVideoSamples } from "../web/file-video.js";

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
