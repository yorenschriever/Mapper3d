import { test } from "node:test";
import assert from "node:assert/strict";
import { findDebugSpot } from "../web/debug-analysis.js";

test("image selection finds the nearest spot allowed by the tracklet filter", () => {
  const tracks = [{ status: "decoded" }, { status: "too short" }];
  const spots = [{ x: 10, y: 10, tracklet: 0 }, { x: 12, y: 10, tracklet: 1 }, { x: 11, y: 10 }];
  assert.equal(findDebugSpot(spots, tracks, "all", 11.9, 10, 4), spots[1]);
  assert.equal(findDebugSpot(spots, tracks, "decoded", 11.9, 10, 4), spots[0]);
  assert.equal(findDebugSpot(spots, tracks, "decoded", 20, 10, 4), null);
});
