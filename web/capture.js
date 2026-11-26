/**
 * Turns a playing <video> (a file or a webcam stream) into an async iterable of
 * {width, height, data, time (ms)} frames. The video is paused while more than `limit` frames
 * wait to be consumed, so a slow analysis never drops frames of a file. Ends when the video
 * ends or `signal` aborts. With `fps`, frames closer together than 1/fps are skipped (the <video>
 * element itself, and so a preview, keeps its full rate); files and streams use their own rate otherwise.
 */
export async function* videoFrames(video, { signal, limit = 4, live = false, fps = 0 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const queue = [];
  let wake = null, done = false, last = -Infinity, idle = 0;
  const notify = () => { wake?.(); wake = null; };
  const onFrame = (now, metadata) => {
    if (done) return;
    const time = live ? (metadata.captureTime ?? now) : metadata.mediaTime * 1000;
    video.requestVideoFrameCallback(onFrame);
    // Small tolerance so a 60 fps source yields every 2nd frame despite timing jitter.
    if (fps && time - last < 1000 / fps - 4) return;
    last = time;
    ctx.drawImage(video, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    queue.push({ width: canvas.width, height: canvas.height, data: image.data, time });
    if (!live && queue.length >= limit) video.pause();
    notify();
  };
  const finish = () => { done = true; notify(); };
  // Some mobile browsers reject or ignore play() after a pause, which would stall the scan silently.
  const resume = () => video.play().catch(error => { stalled = error; notify(); });
  let stalled = null;
  video.addEventListener("ended", finish);
  signal?.addEventListener("abort", finish);
  video.requestVideoFrameCallback(onFrame);
  await video.play();
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift();
        if (!live && video.paused && !video.ended && queue.length < limit / 2) resume();
      } else if (done) {
        return;
      } else {
        // Waiting for a frame: if the video is not advancing, kick it and eventually give up.
        const timer = setTimeout(notify, 2000);
        const before = video.currentTime;
        await new Promise(resolve => { wake = resolve; });
        clearTimeout(timer);
        if (stalled) throw new Error(`The browser would not play the video (${stalled.message})`);
        if (!queue.length && !done && video.currentTime === before) {
          if (video.paused) resume();
          if (++idle >= 5) throw new Error("The video stopped playing. Keep this tab in the foreground while scanning.");
        } else idle = 0;
      }
    }
  } finally {
    done = true;
    video.pause();
  }
}
