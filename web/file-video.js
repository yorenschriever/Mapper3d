import { MP4Box, DataStream } from "./vendor/mp4box.js";

const CHUNK_SIZE = 1024 * 1024;
const MAX_DECODE_QUEUE = 8;

/** Read samples in file order, retaining only the current stream chunk and sample. */
export async function* readVideoSamples(file, samples, signal) {
  const reader = file.stream().getReader();
  let position = 0, buffer = new Uint8Array(0), at = 0;
  try {
    for (const sample of samples) {
      if (sample.offset < position) throw new Error("Video samples are not in sequential file order.");
      const bytes = new Uint8Array(sample.size);
      let written = 0;
      while (written < bytes.length) {
        if (signal?.aborted) return;
        if (at === buffer.length) {
          const result = await reader.read();
          if (result.done) throw new Error(`Video file ended while reading frame ${sample.number + 1}.`);
          buffer = result.value; at = 0;
        }
        const skip = Math.min(Math.max(0, sample.offset - position), buffer.length - at);
        at += skip; position += skip;
        if (position < sample.offset) continue;
        const count = Math.min(bytes.length - written, buffer.length - at);
        bytes.set(buffer.subarray(at, at + count), written);
        written += count; at += count; position += count;
      }
      yield bytes;
    }
  } finally {
    await reader.cancel();
  }
}

/** Open a non-fragmented MP4 and decode its video samples without seeking a video element. */
export async function openVideoFile(file, signal) {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
    throw new Error("This browser does not support WebCodecs video decoding. Try a current version of Chrome.");
  }
  const mp4 = MP4Box.createFile(false);
  let info, parseError;
  mp4.onReady = value => { info = value; };
  mp4.onError = error => { parseError = error; };
  for (let offset = 0; offset < file.size && !info;) {
    if (signal?.aborted) throw new Error("Cancelled");
    const data = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    data.fileStart = offset;
    const next = mp4.appendBuffer(data);
    if (parseError) throw new Error(`Cannot read MP4 metadata: ${parseError}`);
    offset = next >= offset + data.byteLength ? next : offset + data.byteLength;
  }
  if (!info) throw new Error("Cannot read MP4 metadata. Select an MP4 video.");
  if (info.isFragmented) throw new Error("Fragmented MP4 videos are not supported.");
  const track = info.videoTracks[0];
  if (!track) throw new Error("This MP4 does not contain a video track.");
  const trak = mp4.getTrackById(track.id);
  const entries = trak.mdia.minf.stbl.stsd.entries;
  const samples = trak.samples;
  if (!samples.length) throw new Error("This video contains no frames.");
  if (samples.some((s, i) => s.description_index !== samples[0].description_index ||
      (i && s.offset < samples[i - 1].offset + samples[i - 1].size))) {
    throw new Error("This MP4 uses a video layout that cannot be read sequentially.");
  }
  const entry = entries[samples[0].description_index];
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  const config = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height };
  if (box) {
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    config.description = new Uint8Array(stream.buffer, 8, stream.position - 8);
  }
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`This browser cannot decode video codec ${track.codec}.`);

  const matrix = trak.tkhd.matrix;
  const [a, b, c, d] = [matrix[0], matrix[1], matrix[3], matrix[4]].map(n => n / 65536);
  const w = track.video.width, h = track.video.height;
  const xs = [0, a * w, c * h, a * w + c * h], ys = [0, b * w, d * h, b * w + d * h];
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const width = Math.round(Math.max(...xs) - minX), height = Math.round(Math.max(...ys) - minY);
  if (!width || !height) throw new Error("This video has an invalid display transform.");
  const duration = track.duration / track.timescale;

  async function* frames(canvas, signal) {
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const reader = readVideoSamples(file, samples, signal);
    let failure, wake, done = false;
    const output = [];
    const notify = () => { wake?.(); wake = null; };
    const decoder = new VideoDecoder({
      output: frame => { output.push(frame); notify(); },
      error: error => { failure = error; notify(); },
    });
    decoder.ondequeue = notify;
    const onAbort = () => notify();
    signal?.addEventListener("abort", onAbort);

    try {
      decoder.configure(config);
      let index = 0, decoded = 0, flushing = false;
      while (!signal?.aborted) {
        if (failure) throw new Error(`Video decoding failed: ${failure.message}`);
        if (output.length) {
          const frame = output.shift();
          try {
            ctx.setTransform(a, b, c, d, -minX, -minY);
            ctx.drawImage(frame, 0, 0, w, h);
            ctx.resetTransform();
            const image = ctx.getImageData(0, 0, width, height);
            decoded++;
            yield { width, height, data: image.data, time: frame.timestamp / 1000 };
          } finally {
            frame.close();
          }
          continue;
        }
        if (done) {
          if (decoded !== samples.length) throw new Error(`Video decoding produced ${decoded} of ${samples.length} frames.`);
          break;
        }
        if (index < samples.length && decoder.decodeQueueSize < MAX_DECODE_QUEUE) {
          const sample = samples[index++];
          const { value: data, done: ended } = await reader.next();
          if (ended) break;
          if (failure) throw new Error(`Video decoding failed: ${failure.message}`);
          decoder.decode(new EncodedVideoChunk({
            type: sample.is_sync ? "key" : "delta",
            timestamp: Math.round(sample.cts * 1e6 / sample.timescale),
            duration: Math.round(sample.duration * 1e6 / sample.timescale),
            data,
          }));
        } else if (index === samples.length && !flushing) {
          flushing = true;
          decoder.flush().then(() => { done = true; notify(); }, error => { failure = error; notify(); });
        } else {
          await new Promise(resolve => { wake = resolve; });
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (decoder.state !== "closed") decoder.close();
      for (const frame of output) frame.close();
      await reader.return();
    }
  }
  return { width, height, duration, frames };
}
