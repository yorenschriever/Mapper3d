import { html, useEffect, useRef, useState } from "../vendor/preact.js";

const svg = (path, size = 24) => html`<svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const KebabIcon = () => html`<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
export const BackIcon = () => svg(html`<path d="M15 5l-7 7 7 7"/>`);
export const CheckIcon = () => svg(html`<path d="M5 12.5l4.5 4.5L19 7.5"/>`, 20);
export const UploadIcon = () => svg(html`<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>`, 20);
export const DownloadIcon = () => svg(html`<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>`, 20);
export const SunIcon = () => svg(html`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>`, 18);

/**
 * A round "more" button with a dropdown. Items are {label, icon, checked, keepOpen, onSelect}
 * or the string "-" for a divider. `checked` (true/false) makes an item a toggle.
 */
export function KebabMenu({ items, label = "More options" }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = e => { if (!root.current?.contains(e.target)) setOpen(false); };
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, [open]);
  return html`
    <div class="menu-root" ref=${root}>
      <button class="round-button" aria-label=${label} aria-expanded=${open} onClick=${() => setOpen(!open)}><${KebabIcon} /></button>
      ${open && html`
        <div class="menu" role="menu">
          ${items.map((item, i) => item === "-"
            ? html`<div class="menu-divider" key=${i}></div>`
            : html`
              <button class="menu-item" role="menuitem" key=${i} onClick=${() => { if (!item.keepOpen) setOpen(false); item.onSelect(); }}>
                <span class="menu-icon">${item.checked === undefined ? item.icon : item.checked && html`<${CheckIcon} />`}</span>
                <span>${item.label}</span>
              </button>`)}
        </div>`}
    </div>`;
}
