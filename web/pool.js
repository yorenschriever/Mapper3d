/**
 * A pool of frame-analysis workers. `spawn()` returns {post(message, transfer), onMessage(handler),
 * terminate()}; it is injected so that the same pool runs on Web Workers and Node worker threads.
 */
export class AnalysisPool {
  constructor(spawn, size) {
    this.size = size;
    this.queue = [];
    this.nextId = 0;
    this.pending = new Map();
    this.workers = Array.from({ length: size }, () => {
      const worker = spawn();
      worker.busy = false;
      worker.onMessage(({ id, spots, error }) => {
        const job = this.pending.get(id);
        this.pending.delete(id);
        worker.busy = false;
        if (error) job.reject(new Error(error)); else job.resolve(spots);
        this.next();
      });
      return worker;
    });
  }

  /** Analyzes a frame. The frame's pixel buffer is handed to the worker (not copied), so the caller must not use `frame.data` afterwards. */
  analyze(frame, options) {
    return new Promise((resolve, reject) => {
      this.queue.push({ frame, options, resolve, reject });
      this.next();
    });
  }

  next() {
    const worker = this.workers.find(w => !w.busy);
    if (!worker || !this.queue.length) return;
    const { frame, options, resolve, reject } = this.queue.shift();
    const id = this.nextId++;
    this.pending.set(id, { resolve, reject });
    worker.busy = true;
    let { buffer } = frame.data;
    // A view on part of a larger buffer cannot be handed over whole, so only that part is copied.
    if (frame.data.byteOffset !== 0 || frame.data.byteLength !== buffer.byteLength) buffer = buffer.slice(frame.data.byteOffset, frame.data.byteOffset + frame.data.byteLength);
    worker.post({ id, width: frame.width, height: frame.height, data: buffer, options }, [buffer]);
  }

  terminate() {
    this.workers.forEach(w => w.terminate());
  }
}
