import { html, useState } from "../vendor/preact.js";

export function errorSummary({ message = "", name = "" }) {
  if (/previous scan stopped unexpectedly/i.test(message)) {
    return "The previous scan stopped unexpectedly. The browser may have run out of memory or the page may have been closed.";
  }
  if (name === "RangeError" || /memory|allocation failed|array length|buffer size|quota/i.test(`${name} ${message}`)) {
    return "The scan may have run out of memory. Try a shorter video or close other tabs and apps.";
  }
  if (name === "NotAllowedError") return "Camera access was denied. Allow it in your browser settings, or upload a video.";
  if (name === "NotFoundError") return "No camera was found. Connect a camera or upload a video.";
  if (/camera needs a secure connection/i.test(message)) return "The camera needs a secure connection. Open this page over HTTPS or on localhost.";
  if (/cannot set camera exposure/i.test(message)) return "Could not change camera exposure. Try another exposure setting or browser.";
  if (/not enough camera movement or shared lights/i.test(message)) {
    return "Could not build a 3D model. Move sideways around the lights and keep more of them in view.";
  }
  if (/no lights could be decoded/i.test(message)) {
    return "Could not identify any lights. Try filming longer with the lights clearly visible.";
  }
  if (/cannot reliably determine the led count/i.test(message)) {
    return "Could not determine the number of lights reliably. Try filming longer with their colors clearly visible.";
  }
  if (/video|mp4|codec/i.test(message)) {
    return "Could not read the video. Try a supported MP4 file or a current version of Chrome.";
  }
  return "The scan could not be completed. Try again, or open the technical details for more information.";
}

export function ErrorNotice({ error, onDismiss }) {
  const [copyStatus, setCopyStatus] = useState("");
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(error.details);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Could not copy. Select the technical details and copy them manually.");
    }
  };
  return html`
    <div class="toast" role="alert">
      <div class="error-heading"><strong>Scan problem</strong><button class="error-dismiss" onClick=${onDismiss}>Dismiss</button></div>
      <p>${errorSummary(error)}</p>
      <details>
        <summary>Technical details</summary>
        <pre>${error.details}</pre>
      </details>
      <div class="error-actions">
        <button class="error-copy" onClick=${copy}>Copy details</button>
        <span role="status">${copyStatus}</span>
      </div>
    </div>`;
}
