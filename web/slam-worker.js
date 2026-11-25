let tracker;
let loops = 0;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      const { ArgusAR } = await import("./vendor/argus/argus_ar.js");
      tracker = await ArgusAR.Initialize(data.width, data.height, data.fov);
      loops = 0;
      self.postMessage({ type: "ready", intrinsics: tracker.intrinsics });
    } else if (data.type === "frame") {
      if (!tracker) throw new Error("Camera tracker is not initialized");
      tracker.memImg.write(new Uint8ClampedArray(data.buffer));
      const status = tracker.system.findCameraPoseAt(
        tracker.memImg.heap.byteOffset, tracker.memCam.ptr, data.time,
      );
      const currentLoops = tracker.getLoopClosureCount();
      const worldChanged = status === 2 || currentLoops !== loops;
      loops = currentLoops;
      const pose = status === 1 ? Array.from(tracker.memCam.read(16)) : null;
      self.postMessage({ type: "pose", status, pose, worldChanged, time: data.time });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
