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

function unpackWords(words) {
  let message = 0n;
  for (const word of words.slice(0, 8)) message = (message << 5n) | BigInt(word);
  if (message >> 36n) return null;
  const payload = Number(message >> 8n);
  const count = payload >>> 14;
  const index = payload & 0x3fff;
  if (count < 1 || count > 10000 || index >= count || crc8(payload) !== Number(message & 255n)) return null;
  return { index, count };
}

function unpack(words, received, errorBudget) {
  const data = words.slice(0, 8);
  const ambiguous = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i] === 0) {
      if (received[i] === 31) data[i] = 31;
      ambiguous.push(i);
    }
  }
  const preferred = unpackWords(data);
  if (preferred) return { result: preferred, extraErrors: 0 };
  let result = null;
  for (let mask = 1; mask < 2 ** ambiguous.length; mask++) {
    const candidate = data.slice();
    for (let bit = 0; bit < ambiguous.length; bit++) {
      if (mask & (1 << bit)) {
        const index = ambiguous[bit];
        candidate[index] = candidate[index] === 0 ? 31 : 0;
      }
    }
    const extraErrors = ambiguous.filter(i =>
      (received[i] === 0 || received[i] === 31) && candidate[i] !== received[i]).length;
    if (extraErrors > errorBudget) continue;
    const decoded = unpackWords(candidate);
    if (!decoded) continue;
    if (result) return null;
    result = { result: decoded, extraErrors };
  }
  return result;
}

export function decodeFrame(symbols) {
  if (symbols.length !== FRAME_SYMBOLS || symbols.slice(0, 4).some((value, i) => value !== (i === 3 ? 4 : 5))) return null;
  const words = [];
  const erasures = [];
  const received = [];
  for (let i = 0; i < 12; i++) {
    const a = symbols[4 + i * 2], b = symbols[5 + i * 2];
    const value = a * 6 + b;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 5 || b < 0 || b > 5 ||
      value > 31 || (i >= 8 && value === 31)) {
      words.push(0);
      received.push(null);
      erasures.push(i);
    } else {
      words.push(value % MODULUS);
      received.push(value);
    }
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
    const errorBudget = Math.floor((4 - erasures.length) / 2) - (positions.length - erasures.length);
    const result = unpack(corrected, received, errorBudget);
    if (result) return { ...result.result, corrections: positions.length + result.extraErrors };
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
    this.sampleHead = 0;
    this.starts = PERIODS_MS.map(() => ({ times: [], head: 0 }));
    this.lastTime = -Infinity;
  }

  sampleAt(target, tolerance) {
    let low = this.sampleHead, high = this.samples.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.samples[mid].time < target) low = mid + 1;
      else high = mid;
    }
    let best = low < this.samples.length ? this.samples[low] : null;
    if (low > this.sampleHead &&
      (!best || target - this.samples[low - 1].time <= best.time - target)) best = this.samples[low - 1];
    if (!best || Math.abs(best.time - target) > tolerance) return null;
    if (best.color != null) return best.color;
    let color = null;
    for (let i = low - 1; i >= this.sampleHead && target - this.samples[i].time <= tolerance; i--) {
      if (this.samples[i].color == null) continue;
      if (color !== null && color !== this.samples[i].color) return null;
      color = this.samples[i].color;
    }
    for (let i = low; i < this.samples.length && this.samples[i].time - target <= tolerance; i++) {
      if (this.samples[i].color == null) continue;
      if (color !== null && color !== this.samples[i].color) return null;
      color = this.samples[i].color;
    }
    return color;
  }

  add(timeMs, color) {
    if (!Number.isFinite(timeMs) || timeMs <= this.lastTime) throw new Error("Video timestamps must increase");
    this.lastTime = timeMs;
    this.samples.push({ time: timeMs, color });
    while (this.sampleHead < this.samples.length && this.samples[this.sampleHead].time < timeMs - 21000) this.sampleHead++;
    if (this.sampleHead > 1024) {
      this.samples.splice(0, this.sampleHead);
      this.sampleHead = 0;
    }
    if (color === 5) {
      for (const queue of this.starts) queue.times.push(timeMs);
    }
    let decoded = null;
    for (let p = 0; p < PERIODS_MS.length; p++) {
      const period = PERIODS_MS[p], queue = this.starts[p];
      while (queue.head < queue.times.length && timeMs >= queue.times[queue.head] + period * 27) {
        const start = queue.times[queue.head++];
        if (timeMs - start > period * 28) continue;
        const tolerance = period * 0.3;
        const symbols = [5];
        for (let symbol = 1; symbol < 4; symbol++) symbols.push(this.sampleAt(start + symbol * period, tolerance));
        if (symbols[1] !== 5 || symbols[2] !== 5 || symbols[3] !== 4) continue;
        for (let symbol = 4; symbol < FRAME_SYMBOLS; symbol++) {
          symbols.push(this.sampleAt(start + symbol * period, tolerance));
        }
        const result = decodeFrame(symbols);
        if (result && (result.count <= 2000 ? 120 : 360) === period) {
          decoded ??= result;
          break;
        }
      }
      if (queue.head > 1024) {
        queue.times.splice(0, queue.head);
        queue.head = 0;
      }
    }
    return decoded;
  }
}
