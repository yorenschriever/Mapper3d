// Helps find out why a scan failed, in particular on a phone where the browser may run out of memory.
// A JavaScript error can be described; when the browser kills the page or a worker there is no error to
// catch, so the scan leaves a trace in localStorage that the next page load reports.
const KEY = "mapper3d.trace";

export function memoryInfo() {
  const heap = performance.memory?.usedJSHeapSize;   // Chrome only; this thread only, not the workers
  return { heapMB: heap && Math.round(heap / 1e6), deviceGB: navigator.deviceMemory, cores: navigator.hardwareConcurrency };
}

export const isMemoryError = error =>
  error?.name === "RangeError" || /memory|allocation failed|array length|buffer size|quota/i.test(`${error?.name} ${error?.message}`);

let state = {};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage may be unavailable */ } };

export const trace = {
  /** Remembers where the scan is; shown after the page died during a scan. */
  update(values) { state = { ...state, ...values, at: Date.now(), memory: memoryInfo() }; save(); },
  snapshot: () => state,
  clear() { state = {}; try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
  /** The trace of a scan that never finished, if the previous page load left one. */
  previous() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
};

document.addEventListener("visibilitychange", () => {
  if (Object.keys(state).length) trace.update({ visibility: document.visibilityState });
});

const summary = values => {
  const { memory, at, ...rest } = values;
  const lines = Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  if (memory) lines.push(`memory: ${JSON.stringify(Object.fromEntries(Object.entries(memory).filter(([, v]) => v !== undefined)))}`);
  return lines.join("\n");
};

/** A multi-line explanation of an error, with what the scan was doing and the device's memory. */
export function describeError(error, context = state) {
  const lines = [];
  lines.push(`${error?.name && error.name !== "Error" ? `${error.name}: ` : ""}${error?.message || "Unknown error"}`);
  if (isMemoryError(error)) lines.push("This looks like the device ran out of memory. Try a shorter or lower resolution video, or close other tabs and apps.");
  lines.push("", summary({ ...context, memory: memoryInfo() }));
  if (error?.stack) lines.push("", error.stack.split("\n").slice(0, 6).join("\n"));
  return lines.join("\n");
}

/** The message for a page that died during a scan, or null when the last scan ended normally. */
export function describePreviousCrash() {
  const previous = trace.previous();
  if (!previous || !Object.keys(previous).length) return null;
  trace.clear();
  return [
    "The previous scan stopped unexpectedly. The browser most likely ran out of memory and closed the page (it can also be the page being closed or reloaded during a scan).",
    "", `Last known state ${previous.at ? `(last update ${Math.round((Date.now() - previous.at) / 1000)} s before this page loaded)` : ""}:`, summary(previous),
  ].join("\n");
}
