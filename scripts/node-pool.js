import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { AnalysisPool } from "../web/pool.js";

/** An AnalysisPool on worker threads, one per core by default. */
export function nodePool(size = availableParallelism()) {
  const url = new URL("../web/analyze-worker.js", import.meta.url);
  return new AnalysisPool(() => {
    const worker = new Worker(url);
    return {
      post: (message, transfer) => worker.postMessage(message, transfer),
      onMessage: handler => worker.on("message", handler),
      terminate: () => worker.terminate(),
    };
  }, size);
}
