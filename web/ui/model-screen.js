import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact.js";
import { download, toHpp } from "./export.js";
import { createModelView, prepareModel } from "./model-view.js";
import { BackIcon, DownloadIcon, KebabMenu } from "./widgets.js";

export function ModelScreen({ model: raw, onBack }) {
  const canvas = useRef(null), view = useRef(null);
  const [options, setOptions] = useState({ lines: true, labels: true, cameras: true });
  const model = useMemo(() => prepareModel(raw), [raw]);

  useEffect(() => {
    view.current = createModelView(canvas.current);
    return () => view.current.destroy();
  }, []);
  useEffect(() => view.current.setModel(model), [model]);
  useEffect(() => view.current.setOptions(options), [options]);

  const toggle = key => ({ keepOpen: true, checked: options[key], onSelect: () => setOptions(o => ({ ...o, [key]: !o[key] })) });
  const items = [
    { label: "String", ...toggle("lines") },
    { label: "Indices", ...toggle("labels") },
    { label: "Camera path", ...toggle("cameras") },
    "-",
    { label: "Export JSON", icon: html`<${DownloadIcon} />`, onSelect: () => download("mapper3d-model.json", JSON.stringify(raw), "application/json") },
    { label: "Export HPP", icon: html`<${DownloadIcon} />`, onSelect: () => download("led_positions.hpp", toHpp(raw), "text/plain") },
  ];
  return html`
    <div class="screen model">
      <canvas ref=${canvas}></canvas>
      <div class="top-bar">
        <button class="round-button" aria-label="New scan" onClick=${onBack}><${BackIcon} /></button>
        <div class="top-right"><${KebabMenu} items=${items} /></div>
      </div>
      <div class="bottom-bar">
        <div class="chip"><b>${raw.points.length}</b> of ${raw.count} lights · ${raw.cameras.length} camera poses · ${(raw.medianError ?? raw.rms).toFixed(1)} px</div>
      </div>
    </div>`;
}
