import { html, useEffect, useRef, useState } from "../vendor/preact.js";
import { KebabMenu, SunIcon, UploadIcon } from "./widgets.js";

// Dim exposure keeps the LEDs from saturating to white; see the exposure notes in the README.
const DEFAULT_EV = -3;

const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Opens the rear camera and returns its stream, or an error message. */
function useCamera(enabled) {
  const [state, setState] = useState({ stream: null, error: null });
  useEffect(() => {
    if (!enabled) { setState({ stream: null, error: null }); return; }
    let stream, cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("The camera needs a secure connection: open this page over https or on localhost.");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: 1280, height: 720, frameRate: 60 }, audio: false });
        if (cancelled) stream.getTracks().forEach(t => t.stop()); else setState({ stream, error: null });
      } catch (error) {
        if (!cancelled) setState({ stream: null, error: error.name === "NotAllowedError" ? "Camera access was denied. Allow it in the browser settings, or upload a video from the menu." : error.message });
      }
    })();
    return () => { cancelled = true; stream?.getTracks().forEach(t => t.stop()); };
  }, [enabled]);
  return state;
}

/** Exposure compensation, where the browser supports it (Chrome on Android does; iOS Safari does not). */
function useExposure(stream) {
  const [range, setRange] = useState(null);
  const [value, setValue] = useState(DEFAULT_EV);
  const track = stream?.getVideoTracks()[0];
  useEffect(() => {
    const capabilities = track?.getCapabilities?.().exposureCompensation;
    setRange(capabilities ?? null);
    if (capabilities) apply(track, Math.min(capabilities.max, Math.max(capabilities.min, DEFAULT_EV)));
  }, [track]);
  const apply = (t, ev) => t.applyConstraints({ advanced: [{ exposureMode: "continuous", exposureCompensation: ev }] }).catch(() => {});
  return { range, value, set: ev => { setValue(ev); apply(track, ev); } };
}

/**
 * Fullscreen camera with a record button. While a file is analyzed instead, the replay of the video
 * takes the place of the camera (`replay` is the element the scan puts the video in).
 */
export function CameraScreen({ job, onRecord, onStop, onFile, onCancel }) {
  const replaying = job?.kind === "file";
  const { stream, error } = useCamera(!replaying);
  const exposure = useExposure(stream);
  const video = useRef(null), replay = useRef(null), picker = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const recording = job?.kind === "live";

  useEffect(() => { if (video.current) video.current.srcObject = stream; }, [stream]);
  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const timer = setInterval(() => setElapsed((performance.now() - job.startedAt) / 1000), 250);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => { if (replaying) job.preview.attach(replay.current); }, [replaying]);

  const fraction = job?.progress?.fraction;
  return html`
    <div class="screen camera">
      ${replaying
        ? html`<div class="replay" ref=${replay}></div>`
        : html`<video ref=${video} autoplay muted playsinline></video>`}
      ${error && !replaying && html`<div class="camera-message">${error}</div>`}

      <div class="top-bar">
        <div class="timer ${recording ? "visible" : ""}"><span class="dot"></span>${clock(elapsed)}</div>
        ${!job && html`
          <div class="top-right">
            <${KebabMenu} items=${[{ label: "Upload video…", icon: html`<${UploadIcon} />`, onSelect: () => picker.current.click() }]} />
          </div>`}
      </div>
      <input type="file" accept="video/*" hidden ref=${picker}
        onChange=${e => { const file = e.target.files[0]; e.target.value = ""; if (file) onFile(file); }} />

      ${replaying
        ? html`
          <div class="bottom-bar">
            <div class="analysis">
              <div class="analysis-text">Analyzing video${fraction !== undefined ? ` · ${Math.round(fraction * 100)}%` : ""}</div>
              <div class="bar"><div class="bar-fill" style=${{ width: `${(fraction ?? 0) * 100}%` }}></div></div>
              <button class="text-button" onClick=${onCancel}>Cancel</button>
            </div>
          </div>`
        : html`
          <div class="bottom-bar">
            ${!recording && exposure.range && html`
              <label class="exposure">
                <${SunIcon} />
                <input type="range" min=${exposure.range.min} max=${exposure.range.max} step=${exposure.range.step || 0.1}
                  value=${exposure.value} onInput=${e => exposure.set(Number(e.target.value))} aria-label="Exposure" />
                <span>${exposure.value.toFixed(1)}</span>
              </label>`}
            <button class="record ${recording ? "recording" : ""}" aria-label=${recording ? "Stop" : "Record"}
              disabled=${!stream}
              onClick=${() => recording ? onStop() : onRecord(stream)}><span></span></button>
            <div class="hint">${recording ? "Move around the lights, then tap to stop" : stream ? "Film the lights from several sides" : ""}</div>
          </div>`}
    </div>`;
}
