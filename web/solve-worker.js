import { decodeTracks } from "./scan.js";
import { framesFromTracks, modelToJson, reconstruct } from "./reconstruct.js";

// Web Worker: decodes tracklets and reconstructs the lights, off the UI thread.
self.onmessage = ({ data: { tracks, width, height, periods } }) => {
  try {
    const scan = decodeTracks(tracks, { periods });
    if (!scan.tracks.length) throw new Error("No lights could be decoded. Film the whole string for longer, in a darker room.");
    const model = reconstruct(framesFromTracks(scan.tracks, 4), { width, height, log: message => self.postMessage({ log: message }) });
    self.postMessage({ model: modelToJson(model, { count: scan.count, width, height }) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
