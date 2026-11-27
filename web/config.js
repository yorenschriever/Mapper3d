export const MAX_SPOTS_PER_FRAME = 500;
export const MAX_RETAINED_TRACKS = 500;
export const SPOT_SEPARATION = 7;

for (const [name, value] of Object.entries({ MAX_SPOTS_PER_FRAME, MAX_RETAINED_TRACKS, SPOT_SEPARATION })) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}
