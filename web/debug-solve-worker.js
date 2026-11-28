import { decodeTracks } from "./scan.js";

self.onmessage = ({ data: tracks }) => {
  try {
    const decoded = [];
    const result = decodeTracks(tracks, { onDecoded: (source, light) => decoded.push({ source, index: light.index, margin: light.margin }) });
    self.postMessage({ count: result.count, decoded });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
