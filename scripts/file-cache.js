import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** A JSON-file cache with the same async interface as the browser's IndexedDB cache. */
export function fileCache(path) {
  const load = () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  return {
    async get(key) { return load()[key] ?? null; },
    async set(key, value) { writeFileSync(path, JSON.stringify({ ...load(), [key]: value })); },
  };
}
