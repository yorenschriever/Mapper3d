import { html } from "../vendor/preact.js";

const RADIUS = 70, CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Shows solve progress; work with no known fraction is shown as a spinner. */
export function ProcessingScreen({ fraction, status = "Finishing the analysis", onCancel }) {
  const known = Number.isFinite(fraction);
  const progress = known ? Math.max(0, Math.min(1, fraction)) : 0;
  const percent = Math.round(progress * 100);
  return html`
    <div class="screen processing">
      <div class="ring ${known ? "" : "spinning"}" role="progressbar" aria-label=${status}
        aria-valuemin="0" aria-valuemax="100" aria-valuenow=${known ? percent : undefined}>
        <svg viewBox="0 0 180 180" width="220" height="220" aria-hidden="true">
          <defs>
            <linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#ff5ea8" /><stop offset="0.5" stop-color="#ffb347" /><stop offset="1" stop-color="#5ee1ff" />
            </linearGradient>
          </defs>
          <circle class="ring-track" cx="90" cy="90" r=${RADIUS} />
          <circle class="ring-fill" cx="90" cy="90" r=${RADIUS}
            stroke-dasharray=${CIRCUMFERENCE}
            stroke-dashoffset=${CIRCUMFERENCE * (known ? 1 - progress : 0.75)} />
        </svg>
        ${known && html`<div class="ring-label">${percent}<small>%</small></div>`}
      </div>
      <div class="status" aria-live="polite">${status}</div>
      <button class="text-button" onClick=${onCancel}>Cancel</button>
    </div>`;
}
