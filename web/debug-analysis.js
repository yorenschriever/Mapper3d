import { MAX_RETAINED_TRACKS } from "./config.js";
import { MIN_TRACK_SAMPLES, repeatsWithCode } from "./scan.js";

export function matchesDebugFilter(track, filter) {
  return filter === "all" || track.status === filter;
}

/** Find the nearest tracklet allowed by the dropdown, including when only one is drawn. */
export function findDebugSpot(spots, tracks, filter, x, y, radius) {
  let nearest = null, distance = radius;
  for (const spot of spots) {
    const track = tracks[spot.tracklet];
    if (!track || !matchesDebugFilter(track, filter)) continue;
    const d = Math.hypot(spot.x - x, spot.y - y);
    if (d <= distance && (nearest === null || d < distance)) { nearest = spot; distance = d; }
  }
  return nearest;
}

/** Classifies every track using the same ordering and filters as the scan pipeline. */
export function debugTracklets(tracker, { minSamples = MIN_TRACK_SAMPLES, maxTracks = MAX_RETAINED_TRACKS } = {}) {
  const tracks = tracker.result(0).map((track, id) => {
    const described = tracker.described(track);
    const status = described < minSamples ? "too short" : !repeatsWithCode(track.samples) ? "non-repeating" : "not decoded";
    return { id, track, described, status, decoded: null };
  });
  let retained = 0;
  for (const track of tracks) {
    if (track.status !== "not decoded") continue;
    if (retained++ >= maxTracks) track.status = "track limit";
  }
  return tracks;
}

/** Index detections by frame and attach the originating tracklet to each observation. */
export function indexDebugFrames(frames, tracks) {
  const framesByTime = new Map(frames.map(frame => [frame.time, frame]));
  const spotsByTime = new Map(frames.map(frame => {
    const spots = new Map();
    frame.spots.forEach(spot => {
      const key = `${spot.x},${spot.y}`;
      if (!spots.has(key)) spots.set(key, []);
      spots.get(key).push(spot);
    });
    return [frame.time, spots];
  }));
  for (const track of tracks) for (const sample of track.track.samples) {
    const spots = spotsByTime.get(sample.time)?.get(`${sample.x},${sample.y}`);
    const spot = spots?.shift();
    if (!spot || !framesByTime.has(sample.time)) throw new Error("A track observation does not match an analyzed spot.");
    spot.tracklet = track.id;
  }
  return frames;
}
