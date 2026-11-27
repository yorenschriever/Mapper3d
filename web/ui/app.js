import { html, render, useEffect, useRef, useState } from "../vendor/preact.js";
import { scan } from "../scan-app.js";
import { describePreviousCrash } from "../diagnostics.js";
import { CameraScreen } from "./camera-screen.js";
import { ModelScreen } from "./model-screen.js";
import { ProcessingScreen } from "./processing-screen.js";
import { ErrorNotice } from "./error-notice.js";

/** Holds the replay canvas of a file scan until the camera screen has a place for it. */
function previewHolder() {
  return {
    el: null, video: null,
    attach(el) { this.el = el; if (this.video) el.replaceChildren(this.video); },
    replaceChildren(...nodes) { this.video = nodes[0] ?? null; this.el?.replaceChildren(...nodes); },
  };
}

function App() {
  const [screen, setScreen] = useState("camera");   // camera -> processing -> model
  const [job, setJob] = useState(null);             // the running scan: {kind, startedAt, progress, preview}
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const running = useRef(null), wakeLock = useRef(null);   // {stop, cancel}: controllers of the running scan

  // A page killed during a scan (usually out of memory) leaves a trace behind.
  useEffect(() => { const crash = describePreviousCrash(); if (crash) setError({ message: crash, details: crash }); }, []);

  // ?model=<url> opens a finished model directly (for development).
  useEffect(() => {
    const url = new URLSearchParams(location.search).get("model");
    if (url) fetch(url).then(r => r.ok ? r.json() : null).then(m => { if (m) { setModel(m); setScreen("model"); } }).catch(() => {});
  }, []);

  async function run(source, kind) {
    if (running.current) return;
    const mine = running.current = { stop: new AbortController(), cancel: new AbortController() };
    const preview = previewHolder();
    setError(null);
    setJob({ kind, startedAt: performance.now(), progress: {}, preview });
    navigator.wakeLock?.request("screen").then(lock => { wakeLock.current = lock; }).catch(() => {});
    try {
      const result = await scan(source, {
        signal: mine.stop.signal, cancel: mine.cancel.signal, preview,
        onProgress: progress => {
          if (mine.cancel.signal.aborted) return;
          if (progress.phase === "solve") setScreen("processing");
          setJob(j => j && { ...j, progress });
        },
      });
      setModel(result);
      setScreen("model");
    } catch (e) {
      if (!mine.cancel.signal.aborted) {
        console.error(e.details ?? e);
        setError({ name: e.name, message: e.message, details: e.details ?? e.stack ?? String(e) });
        setScreen("camera");
      }
    } finally {
      if (running.current === mine) { running.current = null; setJob(null); }
      wakeLock.current?.release?.().catch(() => {});
      wakeLock.current = null;
    }
  }

  const stop = () => { setScreen("processing"); running.current?.stop.abort(); };
  const cancel = () => {
    running.current?.cancel.abort();
    running.current?.stop.abort();
    running.current = null;
    setJob(null);
    setScreen("camera");
  };

  return html`
    <${Screen} screen=${screen}>
      ${screen === "camera" && html`<${CameraScreen} job=${job} onRecord=${stream => run({ stream }, "live")} onStop=${stop}
        onFile=${file => run({ file }, "file")} onCancel=${cancel} onCameraError=${e => setError(current => current ?? e)} />`}
      ${screen === "processing" && html`<${ProcessingScreen} status=${job?.progress?.status}
        fraction=${job?.progress?.phase === "solve" ? job.progress.fraction : undefined} onCancel=${cancel} />`}
      ${screen === "model" && html`<${ModelScreen} model=${model} onBack=${() => { setModel(null); setScreen("camera"); }} />`}
      ${error && html`<${ErrorNotice} error=${error} onDismiss=${() => setError(null)} />`}
    <//>`;
}

const Screen = ({ screen, children }) => html`<div class="app" data-screen=${screen}>${children}</div>`;

render(html`<${App} />`, document.getElementById("app"));
