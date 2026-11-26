import { html } from "../vendor/preact.js";

const RADIUS = 70, CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A circular progress ring. Without a fraction it spins, for work whose length is unknown. */
export function ProcessingScreen({ fraction, onCancel }) {
  const known = fraction !== undefined;
  const percent = known ? Math.round(fraction * 100) : 0;
  const status = !known ? "Finishing the analysis" : fraction < 0.2 ? "Decoding the LED codes" : "Building the 3D model";
  return html`
    <div class="screen processing">
      <div class="ring ${known ? "" : "spinning"}">
        <svg viewBox="0 0 180 180" width="220" height="220" aria-hidden="true">
          <defs>
            <linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#ff5ea8" /><stop offset="0.5" stop-color="#ffb347" /><stop offset="1" stop-color="#5ee1ff" />
            </linearGradient>
          </defs>
          <circle class="ring-track" cx="90" cy="90" r=${RADIUS} />
          <circle class="ring-fill" cx="90" cy="90" r=${RADIUS}
            stroke-dasharray=${CIRCUMFERENCE}
            stroke-dashoffset=${known ? CIRCUMFERENCE * (1 - fraction) : CIRCUMFERENCE * 0.75} />
        </svg>
        <div class="ring-label" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${known ? percent : undefined}>${known ? html`${percent}<small>%</small>` : ""}</div>
      </div>
      <div class="status">${status}</div>
      <button class="text-button" onClick=${onCancel}>Cancel</button>
    </div>`;
}
