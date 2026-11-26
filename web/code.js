// Protocol v2 code, matching firmware/main/protocol.c.
export const COLOR_COUNT = 5;
export const FRAME_SLOTS = 28;
export const INDEX_SYMBOLS = 10;
export const COUNT_SYMBOLS = 4;
export const FIELD = 23;
export const MAX_VALUE = FIELD ** 3;
export const PERIODS_MS = [120, 360];
const OFFSET = [17, 3, 11, 20, 6, 14, 1, 9, 22, 12, 5, 18, 8, 15];

export function periodForCount(count) {
  return count <= 2000 ? PERIODS_MS[0] : PERIODS_MS[1];
}

/** Symbols (0..22) of a Reed-Solomon word for a number below 23^3. */
export function wordSymbols(value, length, offset = 0) {
  const digits = [value % FIELD, Math.floor(value / FIELD) % FIELD, Math.floor(value / FIELD ** 2) % FIELD];
  return Array.from({ length }, (_, j) => {
    const x = j + 1;
    return (digits[0] + digits[1] * x + digits[2] * x * x + OFFSET[offset + j]) % FIELD;
  });
}

export function symbolColors(symbols) {
  return symbols.flatMap(value => [Math.floor(value / COLOR_COUNT), value % COLOR_COUNT]);
}

/** The 20 colors of an LED's index word. */
export function indexColors(index) {
  return symbolColors(wordSymbols(index, INDEX_SYMBOLS));
}

/** The 8 colors of the count word. */
export function countColors(count) {
  return symbolColors(wordSymbols(count, COUNT_SYMBOLS, INDEX_SYMBOLS));
}

/** The 28 colors an LED shows per cycle. */
export function frameColors(index, count) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 10000 || index < 0 || index >= count) {
    throw new RangeError("Invalid LED index or count");
  }
  return [...indexColors(index), ...countColors(count)];
}
