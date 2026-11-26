import { analyzeFrame } from "./analyze.js";

// Runs in a browser Web Worker or a Node worker thread: {id, width, height, data: ArrayBuffer} -> {id, spots}.
const port = typeof self !== "undefined" && typeof self.postMessage === "function" && typeof WorkerGlobalScope !== "undefined"
  ? { on: handler => { self.onmessage = e => handler(e.data); }, post: message => self.postMessage(message) }
  : await import("node:worker_threads").then(({ parentPort }) => ({ on: handler => parentPort.on("message", handler), post: message => parentPort.postMessage(message) }));

port.on(({ id, width, height, data, options }) => {
  port.post({ id, spots: analyzeFrame({ width, height, data: new Uint8ClampedArray(data) }, options) });
});
