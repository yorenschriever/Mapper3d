/**
 * Turns a <video> into an async iterable of {width, height, data, time (ms)} frames.
 * A file is read by seeking frame by frame, so every frame is delivered at the file's own frame rate,
 * and a background tab or slow analysis cannot make playback skip frames. A webcam stream is played live;
 * with `fps`, frames closer together than 1/fps are skipped (the <video> element itself, and so a preview,
 * keeps its full rate). Ends when the video ends or `signal` aborts. A file's frames are drawn on `canvas`
 * (made if not given), which can be shown as a replay: unlike a seeking <video>, it is painted on every browser.
 */
export async function* videoFrames(video, { signal, live = false, fps = 0, canvas } = {}) {
  if (live) yield* liveFrames(video, { signal, fps });
  else yield* fileFrames(video, { signal, canvas });
}

async function* fileFrames(video, { signal, canvas = document.createElement("canvas") }) {
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const seek = time => new Promise((resolve, reject) => {
    video.onseeked = resolve;
    video.onerror = () => reject(new Error("Cannot read this video"));
    video.currentTime = time;
  });
  // Presentation time of the frame shown after a seek; falls back to currentTime where callbacks are unavailable.
  const shownTime = async time => {
    let timer;
    const shown = new Promise(resolve => {
      timer = setTimeout(() => resolve(video.currentTime), 1500);
      video.requestVideoFrameCallback((now, metadata) => resolve(metadata.mediaTime));
    });
    await seek(time);
    const mediaTime = await shown;
    clearTimeout(timer);
    return mediaTime;
  };
  video.pause();
  let mediaTime = await shownTime(0);
  // The frame duration is found by probing forward until a later frame appears.
  let step = 0;
  for (let probe = 1; probe <= 120 && !step; probe++) {
    const t = await shownTime(mediaTime + probe / 240);
    if (t > mediaTime + 1e-4) step = t - mediaTime;
  }
  if (!step) throw new Error("Cannot find the frame rate of this video");
  let index = Math.round(mediaTime / step);
  // The probe left the video on frame 1; start from frame 0 again.
  mediaTime = await shownTime(0);
  const end = video.duration;
  while (!signal?.aborted && mediaTime < end) {
    ctx.drawImage(video, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    yield { width: canvas.width, height: canvas.height, data: image.data, time: mediaTime * 1000 };
    // Aim in the middle of the next frame's interval, so rounding never lands on the current frame.
    // Some browsers land on the same frame; retry further ahead before giving up.
    let next = mediaTime;
    for (let ahead = 1.5; ahead <= 6 && next <= mediaTime + 1e-4; ahead += 1.5) next = await shownTime(mediaTime + ahead * step);
    if (next <= mediaTime + 1e-4) break;
    mediaTime = next;
  }
}

async function* liveFrames(video, { signal, fps }) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const queue = [];
  let wake = null, done = false, last = -Infinity, idle = 0;
  const notify = () => { wake?.(); wake = null; };
  const onFrame = (now, metadata) => {
    if (done) return;
    const time = metadata.captureTime ?? now;
    video.requestVideoFrameCallback(onFrame);
    // Small tolerance so a 60 fps source yields every 2nd frame despite timing jitter.
    if (fps && time - last < 1000 / fps - 4) return;
    last = time;
    ctx.drawImage(video, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    queue.push({ width: canvas.width, height: canvas.height, data: image.data, time });
    notify();
  };
  const finish = () => { done = true; notify(); };
  video.addEventListener("ended", finish);
  signal?.addEventListener("abort", finish);
  video.requestVideoFrameCallback(onFrame);
  await video.play();
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift();
      } else if (done) {
        return;
      } else {
        // Waiting for a frame: if the video is not advancing, kick it and eventually give up.
        const timer = setTimeout(notify, 2000);
        const before = video.currentTime;
        await new Promise(resolve => { wake = resolve; });
        clearTimeout(timer);
        if (!queue.length && !done && video.currentTime === before) {
          if (video.paused) video.play().catch(() => {});
          if (++idle >= 5) throw new Error("The video stopped playing. Keep this tab in the foreground while scanning.");
        } else idle = 0;
      }
    }
  } finally {
    done = true;
    video.pause();
  }
}
