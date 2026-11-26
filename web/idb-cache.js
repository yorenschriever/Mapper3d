/** A {get, set} cache in IndexedDB (async), for scanned tracklets. */
export function idbCache(name = "mapper3d") {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = action(db.transaction("kv", mode).objectStore("kv"));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    get: key => run("readonly", store => store.get(key)),
    set: (key, value) => run("readwrite", store => store.put(value, key)),
  };
}
