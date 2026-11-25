import { StreamDecoder } from "./protocol.js";
import { argusFovParameter, cameraRay, triangulate } from "./geometry.js";
import { LightTracker } from "./led-tracker.js";

const video = document.querySelector("#video");
const canvas = document.querySelector("#canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
const status = document.querySelector("#status");
const result = document.querySelector("#result");
const poseStatus = document.querySelector("#pose-status");
const position = document.querySelector("#position");
const fovInput = document.querySelector("#fov");
const slamCanvas = document.createElement("canvas");
const slamContext = slamCanvas.getContext("2d", { willReadFrequently: true });
let selection = null;
let decoder = new StreamDecoder();
let objectUrl = null;
let stream = null;
let lastVideoTime = -1;
let worker = null;
let workerReady = false;
let workerBusy = false;
let lastPoseTime = -Infinity;
let pending = null;
let intrinsics = null;
let reference = null;
let rays = [];
let decodedId = null;
let decodedCount = null;
let selectionVersion = 0;
let lastTriangulation = -Infinity;
let lastFoundTime = -Infinity;
let lightTracker = null;
let visionError = null;

const visionScript = document.createElement("script");
visionScript.src = "./vendor/opencv/opencv.js";
function visionFailed(error) {
  visionError = error instanceof Error ? error.message : String(error);
  status.textContent = `LED tracker failed: ${visionError}`;
}

visionScript.onload = () => {
  try {
    const cv = window.cv;
    const ready = runtime => {
      try {
        if (!runtime?.Mat || !runtime.calcOpticalFlowPyrLK) throw new Error("OpenCV.js is missing optical flow");
        lightTracker = new LightTracker(runtime);
      } catch (error) {
        visionFailed(error);
      }
    };
    if (cv?.Mat) ready(cv);
    else if (typeof cv?.then === "function") cv.then(ready, visionFailed);
    else throw new Error("OpenCV.js did not initialize");
  } catch (error) {
    visionFailed(error);
  }
};
visionScript.onerror = () => {
  visionFailed(new Error("OpenCV.js could not be loaded; run npm install"));
};
document.head.appendChild(visionScript);

function resetObservations() {
  rays = [];
  position.textContent = "";
  lastTriangulation = -Infinity;
}

function stopSlam() {
  if (worker) worker.terminate();
  worker = null;
  workerReady = false;
  workerBusy = false;
  pending = null;
  intrinsics = null;
  reference = null;
  lastPoseTime = -Infinity;
  resetObservations();
}

function startSlam() {
  stopSlam();
  const horizontalFov = Number(fovInput.value);
  if (!Number.isFinite(horizontalFov) || horizontalFov < 30 || horizontalFov > 120) {
    poseStatus.textContent = "Camera tracking requires a horizontal field of view between 30 and 120 degrees.";
    return;
  }
  const scale = Math.min(1, 640 / video.videoWidth);
  slamCanvas.width = Math.round(video.videoWidth * scale);
  slamCanvas.height = Math.round(video.videoHeight * scale);
  const currentWorker = new Worker("./slam-worker.js", { type: "module" });
  worker = currentWorker;
  poseStatus.textContent = "Loading camera tracker…";
  currentWorker.onmessage = ({ data }) => {
    if (worker !== currentWorker) return;
    if (data.type === "ready") {
      intrinsics = data.intrinsics;
      workerReady = true;
      poseStatus.textContent = "Initializing camera tracking: move slowly sideways in a textured scene.";
    } else if (data.type === "error") {
      stopSlam();
      poseStatus.textContent = `Camera tracking failed: ${data.message}. Run npm run setup:slam and serve web/ again.`;
    } else if (data.type === "pose") {
      workerBusy = false;
      if (data.worldChanged) {
        reference = null;
        resetObservations();
      }
      if (!data.pose) {
        poseStatus.textContent = data.status === 2
          ? "Camera tracking reset; previous 3D observations were discarded."
          : "Initializing camera tracking: move slowly sideways in a textured scene.";
        return;
      }
      if (!reference) reference = data.pose;
      poseStatus.textContent = data.worldChanged
        ? "The camera map changed; previous 3D observations were discarded."
        : "Camera tracking active. First tracked view is the coordinate reference.";
      if (pending && pending.version === selectionVersion) {
        rays.push(cameraRay(data.pose, reference, intrinsics, pending.x, pending.y));
        if (rays.length > 200) rays.shift();
        if (decodedId !== null && data.time - lastTriangulation >= 1000) {
          lastTriangulation = data.time;
          const estimate = triangulate(rays);
          position.textContent = estimate
            ? `LED ${decodedId}: [${estimate.point.map(value => value.toFixed(3)).join(", ")}] in arbitrary camera-relative units (${estimate.inliers}/${estimate.observations} views).`
            : "More separated, consistent camera views are needed for a 3D estimate.";
        }
      }
      pending = null;
    }
  };
  currentWorker.onerror = event => {
    if (worker !== currentWorker) return;
    stopSlam();
    poseStatus.textContent = `Camera tracker failed: ${event.message}`;
  };
  currentWorker.postMessage({
    type: "init", width: slamCanvas.width, height: slamCanvas.height,
    fov: argusFovParameter(slamCanvas.width, slamCanvas.height, horizontalFov),
  });
}

function reset() {
  lightTracker?.reset();
  selection = null;
  decoder = new StreamDecoder();
  lastVideoTime = -1;
  result.textContent = "";
  status.textContent = "Tap an LED in the image below the video.";
  decodedId = null;
  decodedCount = null;
  lastFoundTime = -Infinity;
  selectionVersion++;
  resetObservations();
}

function releaseSource() {
  stopSlam();
  lightTracker?.reset();
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  video.removeAttribute("src");
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

document.querySelector("#camera").addEventListener("click", async () => {
  try {
    releaseSource();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    reset();
    startSlam();
  } catch (error) {
    status.textContent = `Camera could not start: ${error.message}`;
  }
});

document.querySelector("#file").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  releaseSource();
  objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  try {
    await video.play();
    reset();
    startSlam();
  } catch (error) {
    status.textContent = `Video could not play: ${error.message}`;
  }
});

video.addEventListener("error", () => {
  status.textContent = "The video could not be decoded by this browser.";
});
video.addEventListener("seeked", () => {
  lightTracker?.reset();
  decoder = new StreamDecoder();
  lastVideoTime = -1;
  result.textContent = "";
  decodedId = null;
  decodedCount = null;
  selectionVersion++;
  if (video.videoWidth) {
    drawCurrentFrame();
    startSlam();
  }
});

canvas.addEventListener("click", event => {
  if (!canvas.width || !canvas.height) return;
  if (!lightTracker) {
    status.textContent = visionError ? `LED tracker failed: ${visionError}` : "LED tracker is still loading.";
    return;
  }
  lightTracker.reset();
  const bounds = canvas.getBoundingClientRect();
  selection = {
    x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height,
  };
  decoder = new StreamDecoder();
  decodedId = null;
  decodedCount = null;
  lastFoundTime = video.currentTime * 1000;
  selectionVersion++;
  resetObservations();
  result.textContent = "";
  status.textContent = "Tracking selected light; waiting for a valid code.";
});

function drawCurrentFrame() {
  const scale = Math.min(1, 1280 / video.videoWidth);
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(video, 0, 0, width, height);
}

function processFrame(_now, metadata) {
  const videoTime = metadata?.mediaTime ?? video.currentTime;
  if (!video.paused && !video.ended && video.readyState >= 2 && videoTime > lastVideoTime) {
    lastVideoTime = videoTime;
    drawCurrentFrame();
    const width = canvas.width, height = canvas.height;
    let found = null;
    if (selection) {
      try {
        found = lightTracker.observe(context.getImageData(0, 0, canvas.width, canvas.height), selection);
      } catch (error) {
        lightTracker.reset();
        selection = null;
        selectionVersion++;
        resetObservations();
        status.textContent = `LED tracking failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (selection) {
      if (found) {
        selection = found;
        lastFoundTime = videoTime * 1000;
        const decoded = decoder.add(videoTime * 1000, found.color);
        if (decoded) {
          if (decodedId !== null && (decodedId !== decoded.index || decodedCount !== decoded.count)) resetObservations();
          decodedId = decoded.index;
          decodedCount = decoded.count;
          result.textContent = `LED ${decoded.index} of ${decoded.count} (zero-based); ${decoded.corrections} corrected codewords.`;
          status.textContent = "Valid code received. Tap another LED to start again.";
        }
        context.strokeStyle = "#fff";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(found.x, found.y, 12, 0, Math.PI * 2);
        context.stroke();
      } else {
        decoder.add(videoTime * 1000, null);
        if (lastFoundTime !== -Infinity && videoTime * 1000 - lastFoundTime > 300) {
          selection = null;
          decodedId = null;
          decodedCount = null;
          selectionVersion++;
          lightTracker.reset();
          resetObservations();
          result.textContent = "";
          status.textContent = "Light tracking was lost; tap the LED again.";
        } else {
          status.textContent = "Light not found near selection; trying to reacquire.";
        }
      }
    }
    if (workerReady && !workerBusy && videoTime * 1000 - lastPoseTime >= 150) {
      lastPoseTime = videoTime * 1000;
      slamContext.drawImage(video, 0, 0, slamCanvas.width, slamCanvas.height);
      const pixels = slamContext.getImageData(0, 0, slamCanvas.width, slamCanvas.height);
      pending = found ? {
        x: found.x * slamCanvas.width / width,
        y: found.y * slamCanvas.height / height,
        version: selectionVersion,
      } : null;
      workerBusy = true;
      worker.postMessage({ type: "frame", time: lastPoseTime, buffer: pixels.data.buffer }, [pixels.data.buffer]);
    }
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(processFrame);
  else requestAnimationFrame(processFrame);
}
if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(processFrame);
else requestAnimationFrame(processFrame);
