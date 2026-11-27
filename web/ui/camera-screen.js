import { html, useEffect, useRef, useState } from "../vendor/preact.js";
import { CameraIcon, KebabMenu, SunIcon, UploadIcon } from "./widgets.js";

// MediaTrack exposureTime is measured in units of 100 microseconds.
const MAX_EXPOSURE_TIME = 10000 / 60;
const CAMERA_STORAGE_KEY = "mapper3d.cameraDeviceId";

const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export async function openRearCamera(mediaDevices, deviceId = "") {
  const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" };
  const stream = await mediaDevices.getUserMedia({ video, audio: false });
  try {
    await stream.getVideoTracks()[0].applyConstraints({
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 },
    });
  } catch (error) {
    console.warn("Could not apply preferred camera resolution and frame rate.", error);
  }
  return stream;
}

function useCamera(enabled) {
  const [preference] = useState(() => {
    try { return { deviceId: localStorage.getItem(CAMERA_STORAGE_KEY) || "", warning: null }; }
    catch (error) {
      console.warn("Could not read the saved camera selection.", error);
      return { deviceId: "", warning: "Camera selection could not be loaded from storage." };
    }
  });
  const [request, setRequest] = useState(() => ({ deviceId: preference.deviceId }));
  const { deviceId } = request;
  const [state, setState] = useState({ stream: null, error: null, selectedId: "", warning: preference.warning });
  const [devices, setDevices] = useState([]);
  const selectedByUser = useRef(false);
  useEffect(() => {
    if (!enabled) { setState(s => ({ ...s, stream: null, error: null })); return; }
    let stream, cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("The camera needs a secure connection: open this page over https or on localhost.");
        let warning = preference.warning, fallback = false;
        try {
          stream = await openRearCamera(navigator.mediaDevices, deviceId);
        } catch (error) {
          if (!deviceId || !["NotFoundError", "OverconstrainedError"].includes(error.name)) throw error;
          console.warn("The selected camera is unavailable; opening the default camera.", error);
          stream = await openRearCamera(navigator.mediaDevices);
          fallback = true;
          warning = "Selected camera is unavailable. Using the default camera.";
        }
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        if (selectedByUser.current && !fallback) {
          try { localStorage.setItem(CAMERA_STORAGE_KEY, deviceId); }
          catch (error) {
            console.warn("Could not save the camera selection.", error);
            warning = "Camera selection could not be saved for next time.";
          }
          selectedByUser.current = false;
        }
        if (fallback) selectedByUser.current = false;
        const selectedId = stream.getVideoTracks()[0]?.getSettings?.().deviceId || (!fallback && deviceId) || "";
        setState({ stream, error: null, selectedId, warning });
      } catch (error) {
        if (!cancelled) setState(s => ({ ...s, stream: null, selectedId: "", error: { name: error.name, message: error.message, details: error.stack ?? String(error) } }));
      }
    })();
    return () => { cancelled = true; stream?.getTracks().forEach(t => t.stop()); };
  }, [enabled, request]);
  useEffect(() => {
    if (!state.stream) return;
    if (!navigator.mediaDevices?.enumerateDevices) {
      setState(s => ({ ...s, warning: "Camera selection is not supported by this browser." }));
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (active) setDevices(list.filter(d => d.kind === "videoinput" && d.deviceId));
      } catch (error) {
        console.warn("Could not list cameras.", error);
        if (active) setState(s => ({ ...s, warning: "Could not list available cameras." }));
      }
    };
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => { active = false; navigator.mediaDevices.removeEventListener?.("devicechange", refresh); };
  }, [state.stream]);
  const select = id => {
    if (id === state.selectedId && state.stream) return;
    selectedByUser.current = true;
    setState(s => ({ ...s, stream: null, error: null, selectedId: id }));
    setRequest({ deviceId: id });
  };
  return { ...state, devices, select };
}

/** Serializes camera changes so fast slider input and recording transitions cannot race. */
export function createExposureControls(track, onChange, onError, {
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  androidChromium = /Android/.test(globalThis.navigator?.userAgent ?? "") && /(?:Chrome|Chromium)\//.test(globalThis.navigator?.userAgent ?? ""),
} = {}) {
  const capabilities = track.getCapabilities?.() ?? {};
  const autoAvailable = capabilities.exposureMode?.includes("continuous") || (!capabilities.exposureMode && !!capabilities.exposureCompensation);
  const range = autoAvailable ? capabilities.exposureCompensation ?? null : null;
  const timeCapability = capabilities.exposureTime;
  let timeRange = null;
  if (capabilities.exposureMode?.includes("manual") && Number.isFinite(timeCapability?.min) && Number.isFinite(timeCapability?.max)) {
    // Chromium Android rounds sub-100 µs minima to zero, which it treats as "not set".
    const min = androidChromium && timeCapability.min === 0 && timeCapability.step > 0 ? timeCapability.step : timeCapability.min;
    let max = Math.min(timeCapability.max, MAX_EXPOSURE_TIME);
    if (timeCapability.step > 0) max = timeCapability.min + Math.floor((max - timeCapability.min) / timeCapability.step + 1e-10) * timeCapability.step;
    if (max >= min) timeRange = { ...timeCapability, min, max };
  }
  let state = {
    range, timeRange, autoAvailable, value: range?.min ?? 0,
    time: timeRange?.min, mode: "auto", warning: null,
  };
  let manualUsable = true;
  let pending = Promise.resolve();
  const run = fn => {
    pending = pending.then(fn).catch(error => onError(error));
    return pending;
  };
  const update = changes => { state = { ...state, ...changes }; onChange(state); };
  const apply = constraints => track.applyConstraints({ advanced: [constraints] });
  const applyAuto = async value => {
    if (!autoAvailable) throw new Error("Automatic exposure is not supported by this camera.");
    await apply({ exposureMode: "continuous", ...(range && { exposureCompensation: value }) });
    const mismatch = settings => {
      if (settings.exposureMode && settings.exposureMode !== "continuous") return "The camera did not enable automatic exposure.";
      if (range && settings.exposureCompensation !== undefined &&
          Math.abs(settings.exposureCompensation - value) > (range.step || 0) / 2 + 1e-6) {
        return "The camera did not apply the requested exposure compensation.";
      }
      return null;
    };
    let settings = track.getSettings?.() ?? {};
    for (const delay of [100, 200, 400]) {
      if (!mismatch(settings)) break;
      await wait(delay);
      settings = track.getSettings?.() ?? {};
    }
    if (mismatch(settings)) throw new Error(mismatch(settings));
    update({ value: range ? settings.exposureCompensation ?? value : value, mode: "auto", warning: null });
  };
  const applyTime = async time => {
    if (!timeRange || !Number.isFinite(time) || time < timeRange.min || time > timeRange.max + 1e-9) {
      throw new Error("The requested exposure time is outside the supported range.");
    }
    // Chromium's Android camera backend reports "none" when auto-exposure is off.
    const manualMode = settings => !settings.exposureMode || settings.exposureMode === "manual" ||
      (androidChromium && settings.exposureMode === "none");
    const settled = async matches => {
      let settings = track.getSettings?.() ?? {};
      for (const delay of [100, 200, 400]) {
        if (matches(settings)) break;
        await wait(delay);
        settings = track.getSettings?.() ?? {};
      }
      return settings;
    };
    if (state.mode !== "manual") {
      await apply({ exposureMode: "manual" });
      await settled(manualMode);
    }
    await apply({ exposureMode: "manual", exposureTime: time });
    const mismatch = settings => {
      if (!manualMode(settings)) return `The camera did not enable manual exposure (reported mode: ${settings.exposureMode}).`;
      if (settings.exposureMode === "none" && !Number.isFinite(settings.exposureTime)) {
        return "The camera reports exposure mode 'none' without an exposure time.";
      }
      if (settings.exposureTime !== undefined && Math.abs(settings.exposureTime - time) > (timeRange.step || 0) / 2 + 1e-6) {
        return `The camera did not apply the requested exposure time (requested: ${time}, reported: ${settings.exposureTime}).`;
      }
      return null;
    };
    let settings = await settled(settings => !mismatch(settings));
    if (mismatch(settings)) {
      await apply({ exposureMode: "manual" });
      await settled(manualMode);
      await apply({ exposureMode: "manual", exposureTime: time });
      settings = await settled(settings => !mismatch(settings));
    }
    const failure = mismatch(settings);
    if (failure) {
      const error = new Error(failure);
      error.name = "ManualExposureError";
      throw error;
    }
    manualUsable = true;
    update({
      time: settings.exposureTime ?? time, mode: "manual",
      warning: settings.exposureMode === "none" ? "Camera reports exposure mode 'none'. Check that changing the time affects the preview." : null,
    });
  };
  const setCompensation = value => run(() => applyAuto(value));
  const setManual = time => run(async () => {
    try {
      await applyTime(typeof time === "function" ? time() : time);
    } catch (error) {
      if (!autoAvailable || !["ManualExposureError", "OverconstrainedError", "NotSupportedError", "OperationError"].includes(error.name)) throw error;
      manualUsable = false;
      console.warn("Manual exposure could not be applied; returning to automatic exposure.", error);
      await applyAuto(state.value);
      update({ warning: `Manual exposure could not be applied: ${error.message} Auto exposure is active; try Manual again.` });
    }
  });
  const setTime = time => setManual(time);
  const setMode = mode => run(() => {
    if (mode === "auto") return applyAuto(state.value);
    throw new Error("Unknown exposure mode.");
  });
  const selectMode = mode => mode === "manual" ? setManual(() => state.time) : setMode(mode);
  const lock = () => run(async () => {
    const settings = track.getSettings?.() ?? {};
    if (capabilities.whiteBalanceMode?.includes("manual")) {
      await apply({ whiteBalanceMode: "manual", ...(settings.colorTemperature !== undefined && { colorTemperature: settings.colorTemperature }) });
    }
    if (manualUsable && capabilities.exposureMode?.includes("manual")) {
      const fixed = Object.fromEntries(["exposureTime", "iso"].filter(k => settings[k] !== undefined).map(k => [k, settings[k]]));
      await apply({ exposureMode: "manual", ...fixed });
    }
  });
  const unlock = () => run(async () => {
    if (capabilities.whiteBalanceMode?.includes("continuous")) await apply({ whiteBalanceMode: "continuous" });
    if (state.mode === "manual") await apply({ exposureMode: "manual", exposureTime: state.time });
    else if (range) await apply({ exposureMode: "continuous", exposureCompensation: state.value });
    else if (capabilities.exposureMode?.includes("continuous")) await apply({ exposureMode: "continuous" });
  });
  onChange(state);
  if (autoAvailable) setCompensation(state.value);
  else if (timeRange) setTime(timeRange.min);
  return { set: setCompensation, setTime, setMode: selectMode, lock, unlock };
}

function useExposure(stream, onError) {
  const [state, setState] = useState({});
  const controls = useRef(null);
  const track = stream?.getVideoTracks()[0];
  useEffect(() => {
    if (!track) { controls.current = null; setState({}); return; }
    let active = true;
    controls.current = createExposureControls(track, value => { if (active) setState(value); }, error => {
      if (active) onError({ name: error.name, message: `Cannot set camera exposure: ${error.message}`, details: error.stack ?? String(error) });
    });
    return () => { active = false; controls.current = null; };
  }, [track]);
  return {
    ...state,
    set: value => controls.current?.set(value),
    setTime: value => controls.current?.setTime(value),
    setMode: mode => controls.current?.setMode(mode),
    lock: controls.current?.lock,
    unlock: controls.current?.unlock,
  };
}

export function ExposureControl({ exposure, devices = [], selectedId = "", select = () => {} }) {
  const hasExposure = exposure.range || exposure.timeRange;
  if (!hasExposure && !devices.length) return null;
  const manual = exposure.mode === "manual";
  return html`
    <div class="exposure">
      <div class="exposure-row">
        ${hasExposure && html`
          <button type="button" class="exposure-toggle" aria-pressed=${manual}
            aria-label=${manual ? "Exposure: manual. Switch to auto" : "Exposure: auto. Switch to manual"}
            title=${manual ? "Manual exposure" : "Auto exposure"}
            disabled=${!exposure.autoAvailable || !exposure.timeRange}
            onClick=${() => exposure.setMode(manual ? "auto" : "manual")}><span aria-hidden="true">${manual ? "M" : "A"}</span></button>`}
        ${manual && exposure.timeRange ? html`
          <label class="exposure-slider">
            <input type="range" min=${exposure.timeRange.min} max=${exposure.timeRange.max} step=${exposure.timeRange.step || "any"}
              value=${exposure.time} onInput=${e => exposure.setTime(Number(e.target.value))} aria-label="Exposure time" />
            <span>${(exposure.time / 10).toFixed(2)} ms</span>
          </label>` : exposure.range ? html`
          <label class="exposure-slider">
            <${SunIcon} />
            <input type="range" min=${exposure.range.min} max=${exposure.range.max} step=${exposure.range.step || 0.1}
              value=${exposure.value} onInput=${e => exposure.set(Number(e.target.value))} aria-label="Exposure compensation" />
            <span>${exposure.value.toFixed(1)} EV</span>
          </label>` : hasExposure && html`<span>Compensation unavailable</span>`}
        ${devices.length > 0 && html`
          <label class="camera-select" title="Select camera">
            <${CameraIcon} />
            <select aria-label="Camera" value=${selectedId} onChange=${e => select(e.target.value)}>
              ${!devices.some(d => d.deviceId === selectedId) && html`<option value="">Select a camera</option>`}
              ${devices.map((d, i) => html`<option value=${d.deviceId} key=${d.deviceId}>${d.label || `Camera ${i + 1}`}</option>`)}
            </select>
          </label>`}
      </div>
      ${exposure.warning && html`<span class="exposure-warning" role="status">${exposure.warning}</span>`}
    </div>`;
}

/**
 * Fullscreen camera with a record button. While a file is analyzed instead, the replay of the video
 * takes the place of the camera (`replay` is the element the scan puts the video in).
 */
export function CameraScreen({ job, onRecord, onStop, onFile, onCancel, onCameraError }) {
  const replaying = job?.kind === "file";
  const { stream, error, devices, selectedId, select, warning } = useCamera(!replaying);
  const exposure = useExposure(stream, onCameraError);
  const video = useRef(null), replay = useRef(null), picker = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const recording = job?.kind === "live";

  useEffect(() => { if (video.current) video.current.srcObject = stream; }, [stream]);
  useEffect(() => { if (error) onCameraError(error); }, [error]);
  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const timer = setInterval(() => setElapsed((performance.now() - job.startedAt) / 1000), 250);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (!recording) return;
    const unlock = exposure.unlock;
    exposure.lock?.();
    return () => unlock?.();
  }, [recording]);
  useEffect(() => { if (replaying) job.preview.attach(replay.current); }, [replaying]);

  const fraction = job?.progress?.fraction;
  return html`
    <div class="screen camera">
      ${replaying
        ? html`<div class="replay" ref=${replay}></div>`
        : html`<video ref=${video} autoplay muted playsinline></video>`}
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
            ${!recording && warning && html`<div class="camera-warning" role="status">${warning}</div>`}
            ${!recording && html`<${ExposureControl} exposure=${exposure} devices=${devices} selectedId=${selectedId} select=${select} />`}
            <button class="record ${recording ? "recording" : ""}" aria-label=${recording ? "Stop" : "Record"}
              disabled=${!stream}
              onClick=${() => recording ? onStop() : onRecord(stream)}><span></span></button>
            <div class="hint">${recording ? "Move around the lights, then tap to stop" : stream ? "Film the lights from several sides" : ""}</div>
          </div>`}
    </div>`;
}
