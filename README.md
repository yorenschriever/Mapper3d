# Mapper3D: tracking prototype

This prototype combines ESP32 beacon firmware with an experimental automatic
light-candidate preview and camera tracking and triangulation of one selected
LED. It does **not** yet reliably track all LEDs, show a 3D preview or scan
coverage, or export a header. Its output is not calibrated or verified for
accuracy.

## Firmware

Use ESP-IDF 5.1 or newer in the 5.x series and a WS2812-compatible RGB strip.
The component manager downloads Espressif's `led_strip` component during the
build. From the `firmware` directory:

```sh
idf.py set-target esp32
idf.py menuconfig
idf.py build flash monitor
```

In **Mapper3D beacon**, set the LED count, data GPIO and brightness. The
default is 100 LEDs on GPIO 18 at brightness 32. The firmware sends the count
alongside every zero-based ID; the browser needs no count entry or connection
to the ESP32. Use a suitable LED power supply, common ground and appropriate
data-level shifting for the strip. A large strip needs proper power
distribution. Do not power it directly from the ESP32.

The original ESP32 RMT backend has no DMA and can be sensitive to interrupt
latency on long strips. The firmware logs an error and stops if preparing and
transmitting a frame exceeds the symbol period. Memory, signal integrity and
timing at high LED counts still need hardware testing.

## Browser test

Install the browser dependencies once:

```sh
npm install
npm run setup:slam
```

The npm install copies the Apache-2.0-licensed OpenCV.js runtime into the web
directory. The second command downloads and SHA-256-verifies the ArgusAR
JavaScript, WebAssembly and license files. They are served locally afterwards;
video is processed locally and is not sent to ArgusAR or another service.
ArgusAR is GPLv3-licensed.
The exact upstream source and build instructions are available at
[ArgusAR revision 43cb262](https://github.com/WangZhewei1027/ArgusAR/tree/43cb262cd32fe5f027c029dc6621694d4eff0d35).
Review the GPL and upstream third-party licenses before distributing the app.

Serve `web/` over HTTPS on the phone; camera access requires a secure context.
For local desktop development, `python3 -m http.server 8000 --directory web`
provides a localhost server. Open the page and start the camera or choose a
video. The default **Automatic preview** marks candidates in cyan, predictions
with dashed circles, and decoded IDs in green. The preview runs in a worker at up to 30 fps,
using frames scaled to at most 640 pixels wide. Its status shows the actual
processing rate. Candidates can include background highlights or reflections,
and decoded IDs can be assigned to the wrong candidate; saturated, occluded or
overlapping LEDs can be missed. It retains competing candidates, including
multiple candidates with the same ID. When a detection disappears, the preview
estimates motion from background optical flow and samples the predicted position;
it falls back to the last velocity when motion cannot be estimated. A candidate
is discarded after three seconds without a detection or usable color sample,
if a predicted position is too close to the image edge, or if frames arrive
more than one second apart. Predicted positions can drift and are not confirmed
LEDs. The preview does not
reconstruct or save 3D positions, and decoding is not yet reliable on real
multi-light footage.

Choose **Select one LED** to use the previous single-light prototype: move
sideways to initialize the camera tracker, then tap an LED in the image below
the video. The tool attempts to follow that one LED and shows its ID and
reported strip count after a valid decode. Keep moving to obtain separated
viewpoints. When there are enough consistent views it shows an experimental
position in arbitrary units relative to the **first successfully tracked** camera
view: X right, Y down, Z forward. The first video frame cannot be used as a
reference if tracking has not initialized yet. Tap again to start over.
Pause and seek a recording to select a specific frame; seeking resets the
tracker and decoder. If tracking resets or closes a loop, earlier 3D
observations are discarded rather than mixing coordinate systems.

The horizontal field-of-view input is an estimate, not camera calibration.
It defaults to 65 degrees; set it before starting a source. Incorrect focal
length, lens distortion, tracker drift and imprecise LED centroids can
significantly distort reconstructed positions. No accuracy or scale guarantee
is implied.

For best results, use moderate diffuse ambient light, keep the surroundings
textured, avoid saturated white LED highlights, move slowly and keep the chosen
light separated from other lights. This is an experimental local tracker; it
can lose a light or switch to a neighbor. A successful decode does not yet
verify that tracking remained on the same physical LED. Test on real footage
before relying on its results.

Run `npm test` from the project root. Tests require Node.js, a C compiler and
FFmpeg with `libx264`. They compile the actual firmware encoder and exercise
the JavaScript decoder, including a generated H.264 video file.
If `test/test_data/mapper3d_test.mp4` is present, an additional regression test
tracks and decodes one LED from that recording at 60 fps and both phases of
30 fps subsampling; the test is skipped otherwise. Experimental automatic
detection and multi-light association are tested together on synthetic images,
and association is tested with labeled crossings and occlusion. In an offline
30 fps test on the supplied recording, the combined detector and associator
decoded two IDs; their physical identities were not independently verified.
The detector suppresses peaks within 8 pixels at preview resolution, so merged lights are not
reliably identified as ambiguous. Phone performance, ESP-IDF builds and 3D
accuracy are not validated by these tests.

## Optical protocol v2 (current firmware)

The firmware in `firmware/` transmits protocol v2; the browser decoders and the recordings made
so far still use v1 (kept in `test/legacy/`). The v2 browser decoder is not written yet.

- Five colors: red, green, blue, yellow, magenta (no cyan), all LEDs lit at all times.
- A frame is 28 slots (one color per symbol period, 120 ms up to 2,000 LEDs, otherwise 360 ms), repeating forever.
- Two colors make one symbol of GF(23) (`5 * first + second`, always below 23).
- Slots 0-19: the LED index as 10 symbols, the evaluations at x = 1..10 of the polynomial whose three
  coefficients are the base-23 digits of the index, plus a fixed offset per symbol. Any 3 correct symbols
  determine the index; the minimum distance between LEDs is 8 symbols.
- Slots 20-27: the LED count as 4 symbols in the same way. Every LED sends the same count.
- There is no marker. The decoder finds the cycle start by trying every rotation and keeping the one
  that yields valid codewords, and the shared clock lets all LEDs agree on one start.
- `web/code.js` is the browser implementation; `test/code.test.js` checks it against the firmware encoder.

## Stationary decoding (protocol v2)

`web/annotate.html` lets you click the lights of a tripod recording in index order and saves a
`.leds.json` ground-truth file. `web/stationary.js` turns a light into a brightness-independent color
descriptor (glow rings relative to the background, because the highlight itself clips to white), and
`web/decode2.js` decodes all lights of a recording. Nothing is trained on earlier videos:

1. Descriptors are averaged by cycle phase over the whole recording.
2. They are clustered into five colors (k-means), and the cycle start and the cluster-to-color
   assignment are the combination that makes the most lights agree with valid Reed-Solomon words.
3. Per-slot color likelihoods feed a maximum-likelihood search over all indices. A decode is accepted
   when its margin over the runner-up exceeds the 99.9th percentile of margins on shuffled slots.
4. The count is decoded from the count slots. Tracklet votes are grouped by decoded index, so each
   distinct LED contributes at most one vote; a strict majority of groups with count evidence is
   required. A single-LED result is checked against shuffled count slots. An inconclusive count is
   reported as an error rather than used as a strip size.
5. A color classifier is refit on the confident lights and everything is decoded again.

`web/scan.js` ties it together without annotations: `web/detect.js` finds blinking lights as peaks of the
per-pixel temporal variance (the scene is static, the lights change color every few frames), snaps each to the
brightest, whitest spot, and all candidates are decoded. Candidates that do not decode with a confident
margin are dropped; when several candidates decode to the same index (halos, reflections) the whitest/brightest one
is kept. On `protocolv2.mp4` it finds and decodes all 20 lights, within about 10 px of the clicked positions,
with no false lights.

On `protocolv2.mp4` (20 lights, 1280x720, 60 fps), all 20 lights decode correctly with no wrong
accepts, also from only the first 4 seconds. Moving cameras and 3D are not handled yet. `test/stationary.test.js` runs the whole scan on the recording when it is present in `test/test_data`.

## Moving camera (protocol v2)

`scanMoving` in `web/scan.js` handles a handheld recording of a static scene. `web/track.js` detects small,
high-contrast bright spots in every frame (the lights are always lit, whatever their color) and tracks
them from frame to frame, predicting with the median motion of all tracks. Tracks break on fast motion or
occlusion, so each track is a tracklet. All LEDs share one clock, so every tracklet is folded by absolute
video time and decoded with the same decoder as the stationary case; tracklets that don't decode are
dropped. If the count is uncertain, color calibration is retried using tracklets that are long enough to
demonstrate a repeating code, while still decoding the shorter tracklets. On `protocolv2_moving.mp4`
(23 s, 20 lights) all 20 indices are decoded from tracklets of 2-15 s, with no
index outside the count. An index typically gets several tracklets (different time ranges, plus some
overlapping ones from reflections).

`web/reconstruct.js` and `web/sfm.js` turn the decoded tracklets into 3D. Because every observation carries a
light index there is no feature matching: frames are subsampled, a robust 8-point essential matrix on a pair
of frames with real parallax gives the first two cameras and points, further cameras are registered by
refining their pose against the known points (starting from neighbouring frames), new lights are
triangulated, and a robust (Huber) bundle adjustment with a shared focal length refines everything. Per
frame, when tracklets overlap, the candidate that best fits the model is kept, which discards most
reflections. The scale is arbitrary. On `protocolv2_moving.mp4` all 20 lights are placed (median reprojection error
1.3 px, 233 of 345 sampled frames registered, neighbouring lights 0.3-0.6 apart in model units) and they lie
roughly on the table plane. There is no ground truth, so absolute accuracy is unverified. Known limits: the
initial pair needs enough parallax and non-flat structure, frames with few known lights are skipped, and
the bundle adjustment's dense system over points will need a sparse version for thousands of lights.
Camera registration is retried after focal-length refinement, which can recover frames and lights that
could not be registered with the initial focal estimate.

### Viewer

`node scripts/reconstruct-video.js <video> web/model.json` scans a handheld recording, reconstructs it and writes a
model (git-ignored). Serve `web/` (`npm run serve` for https on the LAN, `--http` for plain http) and open
`viewer.html`, a three-screen app (Preact + htm, vendored in `web/vendor/preact.js`, so there is no build step; the
screens are in `web/ui/`):

1. **Camera**: a fullscreen preview with a record button. Tap it to start scanning and again to stop. The top-right
   menu has "Upload video…": the video then replays while its frames are analyzed.
2. **Processing**: a progress ring and stage while the lights are decoded and reconstructed. The percentage is
   approximate: solving stages can take very different amounts of time.
3. **Model**: initially centered and fitted to the view; drag to rotate,
   pinch or wheel to zoom, shift-drag or two fingers to pan, tap a light to identify it.
   The menu toggles the string, the indices and the camera path, and exports the model as JSON or as a C++ header
   (`LED_POSITIONS[LED_COUNT]` of `{x, y, z}` floats by LED index, centered, z up and scaled to the farthest light
   at distance 1; lights that were not found are `NAN`). The camera path is hidden by default. The string is
   leveled by its least-spread direction.

Scan errors show a short explanation, with expandable technical details that can be copied to the clipboard.

`viewer.html?model=<url>` opens a finished model directly.

### Speed and scaling

The cost of a scan is per frame, not per light (until the spot cap per frame), so it grows with video length:
roughly 1 s of video costs 1 s of single-core time. `web/analyze.js` does the per-frame work (spot detection at
half resolution, refined at full resolution; the expensive color descriptor only for spots with a colorful glow)
and is independent per frame, so `web/pool.js` runs it on one worker per core (`scripts/node-pool.js` for Node,
Web Workers in the browser); the tracker (position-only, spatial grid) runs on the main thread and is
gap-aware, because players drop frames. Measured on `protocolv2_moving.mp4` (1379 frames, 8 cores): 139 s before,
about 25 s now. The CLI caches tracklets and descriptors in `<output>.cache.json` (keyed by file identity and `PIPELINE_VERSION`), so
decoding or reconstruction can be rerun in a few seconds. The browser does not cache: every scan starts clean.
Decoding grows with tracks x LED count (a few seconds for 300 tracks); the bundle adjustment will become the
limit at hundreds of lights. Not done: WASM, WebGPU, and a cheap first-pass decoder.

### Scanning in the browser

`viewer.html` scans the camera or an uploaded video file with the same pipeline (`web/scan-app.js`):
full-resolution frames go to a worker pool, then `web/solve-worker.js` decodes and reconstructs off the UI thread.
Edit `web/config.js` to configure the maximum spots per frame (default 500), retained tracklets
(default 500), and spot separation (default 7) for browser and command-line scans. Spot separation is a
positive integer measured on the half-resolution detection image: candidates closer than that in both
axes are suppressed. Lower values can find closer lights but may add duplicate or false candidates.
Higher limits can increase processing time, memory use and false candidates. The tracklet limit is applied
after tracking and repeat filtering, not while recording.
The color sampler estimates each spot's bright-core size and scales its glow and background sampling
areas accordingly, within bounded limits. Closely spaced or heavily overlapping lights can still
contaminate each other's color samples, and the fixed-size colorfulness prefilter can miss large lights.
Uploaded files are decoded sequentially with WebCodecs and the vendored MP4Box.js demuxer, without seeking
or relying on realtime playback. File scanning requires WebCodecs and a supported codec in a non-fragmented
MP4; unsupported browsers, formats and codecs report an error. The MP4 metadata may be read from the end of
the file before its media data is streamed. MP4Box.js is vendored in `web/vendor/` with its license, so
the app still runs without a build step. The live camera is analyzed at 30 fps
while its preview stays at the camera's rate. Use the camera selector to choose a lens; the choice is
saved in local storage and reused on subsequent visits. If it is unavailable, the browser's default
rear-facing camera is used and a warning is shown. Resolution and frame-rate preferences are applied
after selecting the camera.
Exposure compensation and manual exposure time are offered
where the browser and camera support them. Exposure starts in auto at minimum compensation. The A/M
toggle switches between automatic exposure compensation and manual exposure time. Manual exposure
starts at the camera's minimum and is capped at
1/60 second (or the camera's maximum, if shorter); it is unavailable if the camera's minimum exceeds 1/60 second.
If the camera cannot apply manual exposure, the control returns to auto where available and shows a warning.
Some Chromium Android cameras report mode `none` after disabling automatic exposure; when the reported
exposure time matches, the control allows manual adjustment but asks you to verify it in the preview.
If Chromium reports a zero minimum, the first positive supported step is used instead.
While recording, white balance and exposure are frozen at the values the camera had
at the start, where the browser allows manual modes (otherwise they stay automatic). The camera path
has not been tried on a real device.

## Optical protocol v1

Each LED continuously repeats 28 color symbols. Colors are numbered red = 0,
green = 1, blue = 2, yellow = 3, cyan = 4, magenta = 5. The marker is
`5,5,5,4`; it cannot occur elsewhere across a valid frame boundary.

The payload is `(count << 14) | index`, with 14 bits each for count and index.
The allowed count is 1–10,000 and the index is in `0..count-1`. Append a
CRC-8/ATM (polynomial `0x07`, initial value 0, no reflection or final XOR),
calculated over the payload as four big-endian bytes. The resulting 36 bits
are padded with four leading zero bits and split into eight most-significant
first 5-bit values. A data value can be 31, represented as colors `5,1`.

These are the first eight values of a 12-value code over the prime field
GF(31), with the data value 31 treated as zero for the parity calculation.
The four parity values satisfy
`sum(code[i] * (i + 1)^j) = 0 mod 31` for `j = 0..3` and `i = 0..11`.
Each value `v` becomes two colors `floor(v / 6), v % 6`. Parity values range
from 0 to 30. The decoder first uses the received data symbols and CRC. If
that fails, it tries alternative 0/31 values within the correction budget and
rejects multiple CRC-valid alternatives. Because 0 and 31 have the same
GF(31) value, parity alone cannot distinguish them: the usual two-error/four-erasure
correction guarantee does not apply to every pattern. Uncorrectable errors can
still theoretically produce a false valid result.

The symbol period is 120 ms for up to 2,000 LEDs and 360 ms above that;
the browser tries both. A full cycle lasts 3.36 or 10.08 seconds respectively.
For up to 2,000 LEDs, ideal samples can find a complete cycle from an arbitrary
start in under 10 seconds. This is a design target, not a guarantee under
occlusion, camera exposure, motion or processing delays. For more than 2,000
LEDs, arbitrary-phase acquisition can take roughly 20 seconds even with ideal
visibility. The 10,000-LED range is an encoding and configuration limit, not
an assertion that a particular ESP32 and strip can reliably drive that many.
# Mapper3d
