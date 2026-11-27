import { decodeTracks } from "./scan.js";
import { framesFromTracks, modelToJson, reconstruct } from "./reconstruct.js";

// Web Worker: decodes tracklets and reconstructs the lights, off the UI thread.
self.onmessage = ({ data: { tracks, width, height } }) => {
  try {
    self.postMessage({ progress: 0.02 });
    self.postMessage({ status: "Decoding light patterns" });
    self.postMessage({ stage: `decoding ${tracks.length} tracks` });
    const scan = decodeTracks(tracks);
    self.postMessage({ stage: `reconstructing from ${scan.tracks.length} decoded tracks` });
    if (!scan.tracks.length) throw new Error("No lights could be decoded. Film the whole string for longer, in a darker room.");
    self.postMessage({ progress: 0.2 });
    const model = reconstruct(framesFromTracks(scan.tracks, 4), {
      width, height,
      log: message => self.postMessage({ log: message }),
      onProgress: fraction => self.postMessage({ progress: 0.2 + 0.8 * fraction }),
      onStage: status => self.postMessage({ status }),
    });
    self.postMessage({ model: modelToJson(model, { count: scan.count, width, height }) });
  } catch (error) {
    self.postMessage({ error: { name: error.name, message: error.message, stack: error.stack } });
  }
};
