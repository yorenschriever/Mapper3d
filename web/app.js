import { classifyColor, StreamDecoder } from "./protocol.js";

const video = document.querySelector("#video");
const canvas = document.querySelector("#canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
const status = document.querySelector("#status");
const result = document.querySelector("#result");
let selection = null;
let decoder = new StreamDecoder();
let objectUrl = null;
let stream = null;
let lastVideoTime = -1;

function reset() {
  selection = null;
  decoder = new StreamDecoder();
  lastVideoTime = -1;
  result.textContent = "";
  status.textContent = "Tap an LED in the image below the video.";
}

function releaseSource() {
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
  } catch (error) {
    status.textContent = `Video could not play: ${error.message}`;
  }
});

video.addEventListener("error", () => {
  status.textContent = "The video could not be decoded by this browser.";
});
video.addEventListener("seeked", () => {
  decoder = new StreamDecoder();
  lastVideoTime = -1;
  result.textContent = "";
});

canvas.addEventListener("click", event => {
  if (!canvas.width || !canvas.height) return;
  const bounds = canvas.getBoundingClientRect();
  selection = {
    x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height,
  };
  decoder = new StreamDecoder();
  result.textContent = "";
  status.textContent = "Tracking selected light; waiting for a valid code.";
});

function track(image, previous) {
  const radius = 35;
  let best = null;
  let score = 0;
  const minX = Math.max(0, Math.floor(previous.x - radius));
  const maxX = Math.min(image.width - 1, Math.ceil(previous.x + radius));
  const minY = Math.max(0, Math.floor(previous.y - radius));
  const maxY = Math.min(image.height - 1, Math.ceil(previous.y + radius));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2];
      const color = classifyColor(r, g, b);
      if (color === null) continue;
      const distance = Math.hypot(x - previous.x, y - previous.y);
      const candidate = Math.max(r, g, b) / (1 + distance / 8);
      if (candidate > score) {
        score = candidate;
        best = { x, y, color };
      }
    }
  }
  return best;
}

function processFrame() {
  if (!video.paused && !video.ended && video.readyState >= 2 && video.currentTime > lastVideoTime) {
    lastVideoTime = video.currentTime;
    const scale = Math.min(1, 1280 / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(video, 0, 0, width, height);
    if (selection) {
      const found = track(context.getImageData(0, 0, canvas.width, canvas.height), selection);
      if (found) {
        selection = found;
        const decoded = decoder.add(video.currentTime * 1000, found.color);
        if (decoded) {
          result.textContent = `LED ${decoded.index} of ${decoded.count} (zero-based); ${decoded.corrections} corrected codewords.`;
          status.textContent = "Valid code received. Tap another LED to start again.";
        }
        context.strokeStyle = "#fff";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(found.x, found.y, 12, 0, Math.PI * 2);
        context.stroke();
      } else {
        decoder.add(video.currentTime * 1000, null);
        status.textContent = "Light not found near selection; tap it again if tracking was lost.";
      }
    }
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(processFrame);
  else requestAnimationFrame(processFrame);
}
if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(processFrame);
else requestAnimationFrame(processFrame);
