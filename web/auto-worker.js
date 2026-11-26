let tracker;
let detectLights;
let sampleLight;
let motionEstimator;
let motionField;
let frameWidth = 0, frameHeight = 0;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      importScripts("./vendor/opencv/opencv.js");
      if (!self.cv?.Mat) {
        await new Promise((resolve, reject) => {
          if (typeof self.cv?.then !== "function") reject(new Error("OpenCV.js did not initialize"));
          else self.cv.then(() => resolve(), reject);
        });
      }
      if (!self.cv?.Mat) throw new Error("OpenCV.js did not initialize");
      const vision = await import("./led-tracker.js");
      const tracking = await import("./multi-light-tracker.js");
      detectLights = vision.detectLights;
      sampleLight = vision.sampleLight;
      motionEstimator = new vision.BackgroundMotion(self.cv);
      motionField = tracking.motionField;
      tracker = new tracking.MultiLightTracker();
      self.postMessage({ type: "ready" });
    } else if (data.type === "frame") {
      if (!tracker) throw new Error("Automatic tracker is not ready");
      if (frameWidth !== data.width || frameHeight !== data.height) {
        tracker.reset();
        motionEstimator.reset();
        frameWidth = data.width;
        frameHeight = data.height;
      }
      const pixels = new Uint8ClampedArray(data.buffer);
      const image = { width: data.width, height: data.height, data: pixels };
      const flow = motionEstimator.observe(image, tracker.tracks);
      const background = new self.cv.Mat();
      let tracks;
      try {
        const detections = detectLights(self.cv, image, background);
        const backgroundPixels = background.data;
        tracks = tracker.observe(data.time, detections, {
          motion: motionField(flow),
          sample: point => sampleLight(image, point, backgroundPixels),
        });
      } finally {
        background.delete();
      }
      self.postMessage({
        type: "frame", width: data.width, height: data.height, buffer: data.buffer, tracks,
      }, [data.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
