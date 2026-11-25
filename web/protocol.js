export const FRAME_SYMBOLS = 28;
export const PERIODS_MS = [120, 360];
const MODULUS = 31;

function mod(value) {
  return ((value % MODULUS) + MODULUS) % MODULUS;
}

function power(base, exponent) {
  let value = 1;
  for (let i = 0; i < exponent; i++) value = mod(value * base);
  return value;
}

function inverse(value) {
  for (let i = 1; i < MODULUS; i++) if (mod(value * i) === 1) return i;
  throw new Error("Singular code matrix");
}

function solve(positions, syndromes) {
  if (!positions.length) return syndromes.every(value => value === 0) ? [] : null;
  const matrix = positions.map((_, row) => [
    ...positions.map(position => power(position + 1, row)),
    syndromes[row],
  ]);
  for (let column = 0; column < positions.length; column++) {
    let pivot = column;
    while (pivot < positions.length && matrix[pivot][column] === 0) pivot++;
    if (pivot === positions.length) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const inv = inverse(matrix[column][column]);
    matrix[column] = matrix[column].map(value => mod(value * inv));
    for (let row = 0; row < positions.length; row++) {
      if (row === column) continue;
      const factor = matrix[row][column];
      matrix[row] = matrix[row].map((value, i) => mod(value - factor * matrix[column][i]));
    }
  }
  const result = matrix.map(row => row[positions.length]);
  return syndromes.every((syndrome, row) =>
    mod(result.reduce((sum, error, i) => sum + error * power(positions[i] + 1, row), 0)) === syndrome
  ) ? result : null;
}

function crc8(payload) {
  let crc = 0;
  for (let shift = 24; shift >= 0; shift -= 8) {
    crc ^= (payload >>> shift) & 255;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 128) ? 7 : 0)) & 255;
  }
  return crc;
}

function unpack(words) {
  let message = 0n;
  for (const word of words.slice(0, 8)) message = (message << 5n) | BigInt(word);
  if (message >> 36n) return null;
  const payload = Number(message >> 8n);
  const count = payload >>> 14;
  const index = payload & 0x3fff;
  if (count < 1 || count > 10000 || index >= count || crc8(payload) !== Number(message & 255n)) return null;
  return { index, count };
}

export function decodeFrame(symbols) {
  if (symbols.length !== FRAME_SYMBOLS || symbols.slice(0, 4).some((value, i) => value !== (i === 3 ? 4 : 5))) return null;
  const words = [];
  const erasures = [];
  for (let i = 0; i < 12; i++) {
    const a = symbols[4 + i * 2], b = symbols[5 + i * 2];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 5 || b < 0 || b > 5 || a * 6 + b >= 31) {
      words.push(0);
      erasures.push(i);
    } else words.push(a * 6 + b);
  }
  if (erasures.length > 4) return null;
  const syndromes = Array.from({ length: 4 }, (_, row) =>
    mod(words.reduce((sum, word, i) => sum + word * power(i + 1, row), 0))
  );
  const available = words.map((_, i) => i).filter(i => !erasures.includes(i));
  const candidates = [erasures];
  if (erasures.length <= 2) {
    for (const a of available) candidates.push([...erasures, a]);
  }
  if (erasures.length === 0) {
    for (let a = 0; a < available.length; a++)
      for (let b = a + 1; b < available.length; b++) candidates.push([available[a], available[b]]);
  }
  for (const positions of candidates) {
    const errors = solve(positions, syndromes);
    if (!errors) continue;
    const corrected = words.slice();
    positions.forEach((position, i) => { corrected[position] = mod(corrected[position] - errors[i]); });
    const result = unpack(corrected);
    if (result) return { ...result, corrections: positions.length };
  }
  return null;
}

export function classifyColor(r, g, b) {
  const max = Math.max(r, g, b);
  if (max < 35) return null;
  const channels = [r, g, b].map(value => value / max);
  const choices = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]];
  const distances = choices.map(color => color.reduce((sum, value, i) => sum + (value - channels[i]) ** 2, 0));
  const best = Math.min(...distances);
  return best <= 0.5 ? distances.indexOf(best) : null;
}

export class StreamDecoder {
  constructor() {
    this.samples = [];
    this.lastTime = -Infinity;
  }

  add(timeMs, color) {
    if (!Number.isFinite(timeMs) || timeMs <= this.lastTime) throw new Error("Video timestamps must increase");
    this.lastTime = timeMs;
    this.samples.push({ time: timeMs, color });
    this.samples = this.samples.filter(sample => sample.time >= timeMs - 21000);
    for (const period of PERIODS_MS) {
      for (const start of this.samples) {
        if (start.color !== 5 || timeMs - start.time < period * 27 || timeMs - start.time > period * 28) continue;
        const symbols = [];
        let cursor = 0;
        for (let i = 0; i < FRAME_SYMBOLS; i++) {
          const target = start.time + i * period;
          while (cursor + 1 < this.samples.length &&
            Math.abs(this.samples[cursor + 1].time - target) < Math.abs(this.samples[cursor].time - target)) cursor++;
          const sample = this.samples[cursor];
          symbols.push(Math.abs(sample.time - target) <= period * 0.3 ? sample.color : null);
        }
        const result = decodeFrame(symbols);
        if (result && (result.count <= 2000 ? 120 : 360) === period) return result;
      }
    }
    return null;
  }
}
