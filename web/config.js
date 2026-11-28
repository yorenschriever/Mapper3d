export const MAX_SPOTS_PER_FRAME = 1000;
export const MAX_RETAINED_TRACKS = 1000;
export const SPOT_SEPARATION = 5;
export const MIN_SPOT_CONTRAST = 30; //60
export const MAX_BUNDLE_POINTS = 50;

for (const [name, value] of Object.entries({ MAX_SPOTS_PER_FRAME, MAX_RETAINED_TRACKS, SPOT_SEPARATION, MAX_BUNDLE_POINTS })) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}
if (!Number.isFinite(MIN_SPOT_CONTRAST) || MIN_SPOT_CONTRAST < 0) throw new RangeError("MIN_SPOT_CONTRAST must be a non-negative finite number");
