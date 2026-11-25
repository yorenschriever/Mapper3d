import { copyFile, mkdir } from "node:fs/promises";

const source = new URL("../node_modules/@techstark/opencv-js/", import.meta.url);
const target = new URL("../web/vendor/opencv/", import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(new URL("dist/opencv.js", source), new URL("opencv.js", target));
await copyFile(new URL("LICENSE", source), new URL("LICENSE", target));
console.log("Installed OpenCV.js browser runtime");
