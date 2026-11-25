# Mapper3D: beacon prototype

This is the first milestone: ESP32 beacon firmware and a browser tool for testing
one LED's optical ID. It does **not** yet reconstruct 3D coordinates, track all
LEDs, show scan coverage, or export a header.

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

Serve `web/` over HTTPS on the phone; camera access requires a secure context.
For local desktop development, `python3 -m http.server 8000 --directory web`
provides a localhost server. Open the page, start the camera or choose a video,
then tap an LED in the image below the video. The tool attempts to follow that
one LED and shows its ID and reported strip count after a valid decode. Tap
again to start over. Seeking a video resets the decoder.

For best results, use moderate diffuse ambient light, keep the surroundings
textured, avoid saturated white LED highlights, move slowly and keep the chosen
light separated from other lights. This is an experimental local tracker; it
can lose a light or switch to a neighbor. A successful decode does not yet
verify that tracking remained on the same physical LED. Test on real footage
before relying on its results.

Run `npm test` from the project root. Tests require Node.js, a C compiler and
FFmpeg with `libx264`. They compile the actual firmware encoder and exercise
the JavaScript decoder, including a generated H.264 video file. Physical
camera behavior, ESP-IDF builds, real-video tracking and 3D accuracy are not
validated by these synthetic tests.

## Optical protocol v1

Each LED continuously repeats 28 color symbols. Colors are numbered red = 0,
green = 1, blue = 2, yellow = 3, cyan = 4, magenta = 5. The marker is
`5,5,5,4`; it cannot occur elsewhere across a valid frame boundary.

The payload is `(count << 14) | index`, with 14 bits each for count and index.
The allowed count is 1–10,000 and the index is in `0..count-1`. Append a
CRC-8/ATM (polynomial `0x07`, initial value 0, no reflection or final XOR),
calculated over the payload as four big-endian bytes. The resulting 36 bits
are padded with four leading zero bits and split into eight most-significant
first 5-bit values.

These are the first eight values of a 12-value code over the prime field
GF(31). The four parity values satisfy
`sum(code[i] * (i + 1)^j) = 0 mod 31` for `j = 0..3` and `i = 0..11`.
Each value `v` becomes two colors `floor(v / 6), v % 6`. The decoder can
correct up to two erroneous codewords, up to four erased codewords, or one
error plus up to two erasures, and checks the CRC and payload bounds.
Uncorrectable errors can still theoretically produce a false valid result.

The symbol period is 120 ms for up to 2,000 LEDs and 360 ms above that;
the browser tries both. A full cycle lasts 3.36 or 10.08 seconds respectively.
For up to 2,000 LEDs, ideal samples can find a complete cycle from an arbitrary
start in under 10 seconds. This is a design target, not a guarantee under
occlusion, camera exposure, motion or processing delays. For more than 2,000
LEDs, arbitrary-phase acquisition can take roughly 20 seconds even with ideal
visibility. The 10,000-LED range is an encoding and configuration limit, not
an assertion that a particular ESP32 and strip can reliably drive that many.
# Mapper3d
