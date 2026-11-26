/**
 * Turns a playing <video> (a file or a webcam stream) into an async iterable of
 * {width, height, data, time (ms)} frames. The video is paused while more than `limit` frames
 * wait to be consumed, so a slow analysis never drops frames of a file. Ends when the video
 * ends or `signal` aborts.
 */
export async function* videoFrames(video, { signal, limit = 4, live = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const queue = [];
  let wake = null, done = false;
  const notify = () => { wake?.(); wake = null; };
  const onFrame = (now, metadata) => {
    if (done) return;
    ctx.drawImage(video, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const time = live ? (metadata.captureTime ?? now) : metadata.mediaTime * 1000;
    queue.push({ width: canvas.width, height: canvas.height, data: image.data, time });
    if (!live && queue.length >= limit) video.pause();
    notify();
    video.requestVideoFrameCallback(onFrame);
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
        if (!live && video.paused && !video.ended && queue.length < limit / 2) video.play();
      } else if (done) {
        return;
      } else {
        await new Promise(resolve => { wake = resolve; });
      }
    }
  } finally {
    done = true;
    video.pause();
  }
}
