# Mapper3D

Mapper3D scans a string of LEDs running the included ESP32 beacon firmware and
reconstructs their positions in a browser. The reconstruction is experimental:
its scale is arbitrary, and absolute accuracy has not been verified.

## Firmware

Use ESP-IDF 5.1 or newer in the 5.x series and a WS2812-compatible RGB strip.
The component manager downloads Espressif's `led_strip` component during the
build. From the `firmware` directory:

```sh
idf.py set-target esp32
idf.py menuconfig
idf.py build flash monitor
```

In **Mapper3D beacon**, set the LED count, data GPIO, brightness and color
order. The defaults are 100 LEDs on GPIO 18, brightness 32 and GRB order. The
firmware sends the count alongside every zero-based ID; the browser needs no
count entry or connection to the ESP32.

Use a suitable LED power supply, common ground and appropriate data-level
shifting for the strip. A large strip needs proper power distribution. Do not
power it directly from the ESP32. The original ESP32 RMT backend has no DMA
and can be sensitive to interrupt latency on long strips. The firmware logs
an error and stops if preparing and transmitting a frame exceeds the symbol
period. Memory, signal integrity and timing at high LED counts still need
hardware testing.

## Viewer

The viewer has no build step or npm runtime dependencies. With Node.js and
OpenSSL installed, serve it from the project root:

```sh
npm run serve
```

Open the printed HTTPS URL on a device on the same network and accept the
self-signed certificate. Camera access requires HTTPS or localhost. For plain
HTTP on localhost, use `npm run serve -- --http` and open
`http://localhost:8080/viewer.html`.

1. **Camera:** tap record to start scanning and again to stop. The menu also
   offers **Upload video**; the video replays while its frames are analyzed.
2. **Processing:** decoding and reconstruction run off the UI thread. The
   displayed percentage is approximate.
3. **Model:** drag to rotate, pinch or wheel to zoom, shift-drag or use two
   fingers to pan, and tap a light to identify it. The menu toggles the string,
   indices and camera path and exports JSON or a C++ header. The header has
   `LED_POSITIONS[LED_COUNT]` of `{x, y, z}` floats by LED index, centered,
   z up and scaled to the farthest light at distance 1; missing lights are
   `NAN`. The string is leveled by its least-spread direction.

`viewer.html?model=<url>` opens a finished model directly. Scan errors show an
explanation and expandable technical details.

Uploaded files require WebCodecs and a supported codec in a non-fragmented MP4.
They are decoded sequentially using the vendored MP4Box.js demuxer. The live
camera is analyzed at 30 fps while its preview stays at the camera's rate.
The camera selector is saved locally and reused; if unavailable, the default
rear-facing camera is used and a warning is shown.

Exposure compensation and manual exposure time are offered where the browser
and camera support them. Exposure starts in auto at minimum compensation.
Manual exposure starts at the camera's minimum and is capped at 1/60 second
or the camera's maximum, whichever is shorter. While recording, white balance
and exposure are frozen where the camera permits it. Some Chromium Android
cameras report mode `none` after disabling automatic exposure; when the
reported exposure time matches, the control allows manual adjustment but asks
you to verify it in the preview.

The scan runs locally. Frame analysis finds and tracks bright spots, then
decodes the shared LED color sequence and reconstructs cameras and lights.
Edit `web/config.js` to configure the maximum spots per frame, retained
tracklets and spot separation. Higher limits can increase processing time,
memory use and false candidates. Closely spaced or overlapping lights can
contaminate each other's color samples. Reconstruction needs enough parallax
and non-flat structure; frames with too few known lights may be skipped.
If reconstruction cannot find a starting pair but decoded lights are available,
the viewer shows an approximate flat projection from the frame containing the
most lights. It does not recover depth or correct perspective, and lights not
visible in that frame are omitted. JSON and C++ exports identify this fallback.
Camera drift, reflections and imperfect detections can distort positions.
Reconstruction refines the cameras using at most `MAX_BUNDLE_POINTS`
spatially and temporally distributed lights (50 by default, configurable in
`web/config.js`), then triangulates the remaining decoded lights with those
cameras. This limits processing cost but errors in the selected lights can
affect the whole model.

For a dense 500-light recording, try `SPOT_SEPARATION = 4`,
`MAX_SPOTS_PER_FRAME = 1000`, and `MAX_RETAINED_TRACKS = 1500` in
`web/config.js`. Separation is measured on the half-resolution detection
image. Nearby spots use smaller color samples to reduce contamination, but
clipped or overlapping lights may still be missed. These settings increase
memory and processing demands and have not yet produced a complete 500-light
reconstruction.

## Tests

From the project root:

```sh
npm test
```

Tests require Node.js and a C compiler. Some tests also require FFmpeg,
FFprobe, and optional recordings and annotations in `test/test_data/`; they
are skipped if the files are absent. The test suite does not validate ESP-IDF
builds, real-device camera behavior or absolute 3D accuracy.

## Optical protocol v2

The firmware and viewer use protocol v2:

- Five colors: red, green, blue, yellow and magenta; all LEDs stay lit.
- A frame is 28 slots, repeating forever. The symbol period is 120 ms for
  all LED counts. Large strips must finish updating within this period.
- Two colors make one symbol of GF(23) (`5 * first + second`, always below
  23).
- Slots 0-19 encode the LED index as 10 evaluations of a polynomial whose
  three coefficients are the base-23 digits of the index, plus a fixed offset
  per symbol. Any 3 correct symbols determine the index.
- Slots 20-27 encode the LED count as 4 symbols in the same way. Every LED
  sends the same count.
- There is no marker. The decoder searches for the cycle start and uses the
  shared clock to combine observations.

`web/code.js` implements the encoder in JavaScript; `test/code.test.js` checks
it against the firmware encoder.
