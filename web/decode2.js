import { COLOR_COUNT, FIELD, FRAME_SLOTS, INDEX_SYMBOLS, COUNT_SYMBOLS, MAX_VALUE, PERIOD_MS, wordSymbols } from "./code.js";

/*
 * Decoder for protocol v2 on a stationary recording.
 *
 * Nothing is trained on earlier recordings. Colors are learned per recording:
 * descriptors are folded by cycle phase, clustered, and the cluster -> color
 * assignment and the cycle start are found by checking which hypothesis makes
 * the lights decode into valid Reed-Solomon words. Then a classifier is refit
 * on the lights that decoded confidently and everything is decoded again.
 */

export const BINS_PER_SLOT = 8;
const BINS = FRAME_SLOTS * BINS_PER_SLOT;
const OFFSET = [17, 3, 11, 20, 6, 14, 1, 9, 22, 12, 5, 18, 8, 15];

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const distance2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; };

/** Mean descriptor per phase bin; samples are {time (ms), features}. */
export function foldSamples(samples, period) {
  const cycle = period * FRAME_SLOTS, size = samples[0].features.length;
  const sums = Array.from({ length: BINS }, () => new Float64Array(size));
  const counts = new Uint32Array(BINS);
  for (const { time, features } of samples) {
    const bin = Math.floor((((time % cycle) + cycle) % cycle) / cycle * BINS) % BINS;
    counts[bin]++;
    for (let i = 0; i < size; i++) sums[bin][i] += features[i];
  }
  return sums.map((sum, bin) => counts[bin] ? Array.from(sum, v => v / counts[bin]) : null);
}

export function kmeans(points, k, random, iterations = 30, init = null) {
  const centers = init ? init.map(c => [...c]) : [points[Math.floor(random() * points.length)]];
  while (centers.length < k) {
    const d = points.map(p => Math.min(...centers.map(c => distance2(p, c))));
    let r = random() * d.reduce((a, b) => a + b, 0), i = 0;
    while (i < d.length - 1 && (r -= d[i]) > 0) i++;
    centers.push(points[i]);
  }
  let labels = new Array(points.length).fill(0), inertia = 0;
  for (let it = 0; it < iterations; it++) {
    inertia = 0;
    labels = points.map(p => {
      let best = 0, bestD = Infinity;
      centers.forEach((c, j) => { const d = distance2(p, c); if (d < bestD) { bestD = d; best = j; } });
      inertia += bestD;
      return best;
    });
    for (let j = 0; j < k; j++) {
      const members = points.filter((_, i) => labels[i] === j);
      if (members.length) centers[j] = members[0].map((_, d) => members.reduce((s, m) => s + m[d], 0) / members.length);
    }
  }
  return { centers, labels, inertia };
}

// Lagrange weights to predict the other symbols from three: PREDICT[combo][target][i].
const COMBOS = [];
for (let a = 0; a < INDEX_SYMBOLS; a++) for (let b = a + 1; b < INDEX_SYMBOLS; b++) for (let c = b + 1; c < INDEX_SYMBOLS; c++) COMBOS.push([a, b, c]);
const inverse = x => { for (let y = 1; y < FIELD; y++) if (x * y % FIELD === 1) return y; return 0; };
const PREDICT = COMBOS.map(points => Array.from({ length: INDEX_SYMBOLS }, (_, target) => points.map((p, i) => {
  let w = 1;
  points.forEach((q, m) => { if (m !== i) w = w * (((target - q) % FIELD + FIELD) % FIELD) % FIELD * inverse(((p - q) % FIELD + FIELD) % FIELD) % FIELD; });
  return w;
})));

/** Best number of index symbols agreeing with one Reed-Solomon word, from hard colors (20 values). */
export function hardAgreement(colors) {
  const y = [];
  for (let j = 0; j < INDEX_SYMBOLS; j++) {
    const v = colors[2 * j] * COLOR_COUNT + colors[2 * j + 1];
    y.push(v < FIELD ? (v - OFFSET[j] + FIELD) % FIELD : -1);
  }
  let best = 0;
  for (let c = 0; c < COMBOS.length; c++) {
    const [a, b, d] = COMBOS[c];
    if (y[a] < 0 || y[b] < 0 || y[d] < 0) continue;
    let agree = 0;
    const table = PREDICT[c];
    for (let t = 0; t < INDEX_SYMBOLS; t++) {
      const w = table[t];
      if ((w[0] * y[a] + w[1] * y[b] + w[2] * y[d]) % FIELD === y[t]) agree++;
    }
    if (agree > best) best = agree;
  }
  return best;
}

// Hue (degrees) of the five colors in the order of COLOR_COUNT's indices: red, green, blue, yellow, magenta.
const COLOR_HUES = [0, 120, 240, 60, 300];
const hueDistance = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** Hue (degrees) and chroma of a descriptor, from the glow rings (descriptor values 4..9). */
function descriptorHue(f) {
  const r = f[4] + f[7], g = f[5] + f[8], b = f[6] + f[9];
  const mean = (r + g + b) / 3;
  const chroma = Math.hypot(r - mean, g - mean, b - mean), size = Math.hypot(r, g, b) || 1;
  return { hue: (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI + 360) % 360, chroma, share: chroma / size };
}

/**
 * Initial color clusters from hue order. Red, yellow, green, blue and magenta always follow each
 * other around the hue circle, whatever the lighting or white balance, so the five hues are
 * clustered on the circle starting from their nominal angles; this is robust against grey clutter
 * and does not depend on a lucky random start. Returns a k-means result whose clusters are in
 * COLOR_HUES order (cluster j is color j), or null when there are too few colorful points.
 */
export function hueModel(points, random) {
  const colorful = points.filter(p => descriptorHue(p).share > 0.3);
  if (colorful.length < 3 * COLOR_COUNT) return null;
  const hues = colorful.map(p => descriptorHue(p).hue);
  let centers = [...COLOR_HUES];
  for (let it = 0; it < 15; it++) {
    const sums = centers.map(() => [0, 0, 0]);
    hues.forEach(h => {
      let best = 0;
      centers.forEach((c, j) => { if (hueDistance(h, c) < hueDistance(h, centers[best])) best = j; });
      sums[best][0] += Math.cos(h * Math.PI / 180); sums[best][1] += Math.sin(h * Math.PI / 180); sums[best][2]++;
    });
    centers = centers.map((c, j) => sums[j][2] ? (Math.atan2(sums[j][1], sums[j][0]) * 180 / Math.PI + 360) % 360 : c);
  }
  const init = centers.map(c => {
    const members = colorful.filter((_, i) => hueDistance(hues[i], c) < 20);
    const pool = members.length ? members : colorful;
    return pool[0].map((_, d) => pool.reduce((sum, m) => sum + m[d], 0) / pool.length);
  });
  return kmeans(points, COLOR_COUNT, random, 30, init);
}

const PERMUTATIONS = (function permute(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permute([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [x, ...rest]));
})([0, 1, 2, 3, 4]);

/** Descriptor of slot s when the cycle starts at bin `rotation`: mean over the central bins. */
function slotDescriptor(folded, rotation, slot) {
  const from = BINS_PER_SLOT >> 2, to = BINS_PER_SLOT - from;
  const vectors = [];
  for (let b = from; b < to; b++) {
    const v = folded[(rotation + slot * BINS_PER_SLOT + b) % BINS];
    if (v) vectors.push(v);
  }
  return vectors.length ? vectors[0].map((_, d) => vectors.reduce((s, v) => s + v[d], 0) / vectors.length) : null;
}

function nearest(point, centers) {
  let best = 0, bestD = Infinity;
  centers.forEach((c, j) => { const d = distance2(point, c); if (d < bestD) { bestD = d; best = j; } });
  return best;
}

/**
 * Finds the cycle start and the cluster -> color assignment shared by all lights.
 * The first `searchLights` entries are used for the search, so put the most reliable lights first.
 * Returns { rotation, assignment (cluster -> color), centers, score }.
 */
export function findCalibration(folds, { restarts = 6, searchLights = 12, seed = 1 } = {}) {
  const random = mulberry(seed);
  const points = folds.flatMap(f => f.filter(Boolean));
  let model = null;
  for (let r = 0; r < restarts; r++) {
    const result = kmeans(points, COLOR_COUNT, random);
    if (!model || result.inertia < model.inertia) model = result;
  }
  // Candidate cluster sets: the best random k-means and the hue-ordered one; the code decides.
  const models = [model, hueModel(points, random)].filter(Boolean);
  const subset = folds.slice(0, searchLights);
  let best = { score: -1 };
  for (const candidate of models) {
    for (let rotation = 0; rotation < BINS; rotation++) {
      const clusters = subset.map(folded => Array.from({ length: INDEX_SYMBOLS * 2 }, (_, s) => {
        const d = slotDescriptor(folded, rotation, s);
        return d ? nearest(d, candidate.centers) : 0;
      }));
      for (const permutation of PERMUTATIONS) {
        let score = 0;
        for (const labels of clusters) score += hardAgreement(labels.map(c => permutation[c]));
        if (score > best.score) best = { score, rotation, assignment: permutation, centers: candidate.centers };
      }
    }
  }
  return best;
}

/** Color classifier: one Gaussian per color with a shared diagonal variance, on descriptors. */
export class ColorClassifier {
  constructor(means, variance) {
    this.means = means;
    this.variance = variance;
  }

  /** Fits from labeled descriptors, shrinking toward `prior` (a ColorClassifier) when classes are thin. */
  static fit(samples, prior, shrink = 5) {
    const size = samples[0].features.length;
    const means = prior.means.map(m => [...m]);
    const counts = new Array(COLOR_COUNT).fill(0);
    const sums = prior.means.map(m => m.map(v => v * shrink));
    for (const { color, features } of samples) {
      counts[color]++;
      features.forEach((v, i) => { sums[color][i] += v; });
    }
    means.forEach((m, c) => m.forEach((_, i) => { m[i] = sums[c][i] / (counts[c] + shrink); }));
    const variance = new Array(size).fill(0);
    for (const { color, features } of samples) features.forEach((v, i) => { variance[i] += (v - means[color][i]) ** 2; });
    return new ColorClassifier(means, variance.map(v => Math.max(v / samples.length, 1e-3)));
  }

  static fromCenters(centers, assignment, folds) {
    const means = new Array(COLOR_COUNT);
    centers.forEach((c, cluster) => { means[assignment[cluster]] = c; });
    const variance = new Array(means[0].length).fill(0);
    let n = 0;
    for (const folded of folds) for (const v of folded) {
      if (!v) continue;
      const c = means[nearest(v, means)];
      v.forEach((x, i) => { variance[i] += (x - c[i]) ** 2; });
      n++;
    }
    return new ColorClassifier(means, variance.map(v => Math.max(v / n, 1e-3)));
  }

  /** Log-likelihoods of each color, tempered by `temperature`. */
  logLikelihood(features, temperature = 1) {
    return this.means.map(mean => {
      let s = 0;
      for (let i = 0; i < features.length; i++) s -= (features[i] - mean[i]) ** 2 / (2 * this.variance[i]);
      return s / temperature;
    });
  }
}

/** Per-slot color log-likelihoods of one folded light, for all 28 slots. */
export function slotLikelihoods(folded, rotation, classifier, temperature) {
  return Array.from({ length: FRAME_SLOTS }, (_, s) => {
    const d = slotDescriptor(folded, rotation, s);
    return d ? classifier.logLikelihood(d, temperature) : new Array(COLOR_COUNT).fill(0);
  });
}

// Reed-Solomon symbols of every value below 23^3, for the index word and the count word.
function wordTable(length, offset) {
  const table = new Uint8Array(MAX_VALUE * length);
  for (let v = 0; v < MAX_VALUE; v++) table.set(wordSymbols(v, length, offset), v * length);
  return table;
}
const INDEX_TABLE = wordTable(INDEX_SYMBOLS, 0);
const COUNT_TABLE = wordTable(COUNT_SYMBOLS, INDEX_SYMBOLS);

function symbolScores(likelihoods, firstSlot, symbols) {
  return Array.from({ length: symbols }, (_, j) => {
    const a = likelihoods[firstSlot + 2 * j], b = likelihoods[firstSlot + 2 * j + 1];
    return Array.from({ length: FIELD }, (_, v) => a[Math.floor(v / COLOR_COUNT)] + b[v % COLOR_COUNT]);
  });
}

function bestWords(scores, table, symbols, limit) {
  let best = -Infinity, second = -Infinity, bestValue = -1;
  for (let value = 0; value < limit; value++) {
    let s = 0;
    for (let j = 0; j < symbols; j++) s += scores[j][table[value * symbols + j]];
    if (s > best) { second = best; best = s; bestValue = value; } else if (s > second) second = s;
  }
  return { value: bestValue, margin: best - second, score: best };
}

/** Maximum-likelihood index for one light and the margin to the runner-up. */
export const decodeIndex = (likelihoods, limit = 10000) => bestWords(symbolScores(likelihoods, 0, INDEX_SYMBOLS), INDEX_TABLE, INDEX_SYMBOLS, limit);

/** Log-likelihood of every index below `limit` for one light. */
export function indexScores(likelihoods, limit) {
  const scores = symbolScores(likelihoods, 0, INDEX_SYMBOLS);
  return Array.from({ length: limit }, (_, value) => {
    let s = 0;
    for (let j = 0; j < INDEX_SYMBOLS; j++) s += scores[j][INDEX_TABLE[value * INDEX_SYMBOLS + j]];
    return s;
  });
}

/** Count decoded from the count slots summed over many lights. */
export function decodeCount(allLikelihoods) {
  const total = Array.from({ length: COUNT_SYMBOLS }, () => new Array(FIELD).fill(0));
  for (const l of allLikelihoods) {
    symbolScores(l, 20, COUNT_SYMBOLS).forEach((row, j) => row.forEach((v, x) => { total[j][x] += v; }));
  }
  let best = -Infinity, second = -Infinity, value = 0;
  for (let v = 1; v <= 10000; v++) {
    let s = 0;
    for (let j = 0; j < COUNT_SYMBOLS; j++) s += total[j][COUNT_TABLE[v * COUNT_SYMBOLS + j]];
    if (s > best) { second = best; best = s; value = v; } else if (s > second) second = s;
  }
  return { count: value, margin: best - second };
}

/** Count votes are grouped by decoded index so fragments of one LED cannot dominate. */
export function consensusCount(likelihoods, results) {
  const groups = new Map();
  for (let i = 0; i < likelihoods.length; i++) {
    const { accepted, index } = results[i];
    if (!accepted) continue;
    const vote = decodeCount([likelihoods[i]]);
    if (!(vote.margin > 0) || vote.count <= index) continue;
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push({ ...vote, likelihoods: likelihoods[i] });
  }
  const votes = new Map();
  for (const group of groups.values()) {
    const counts = new Map();
    for (const vote of group) counts.set(vote.count, (counts.get(vote.count) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
    const count = ranked[0][0];
    votes.set(count, (votes.get(count) ?? 0) + 1);
  }
  const winner = [...votes].sort((a, b) => b[1] - a[1])[0];
  if (!winner || winner[1] <= groups.size / 2) return { count: null, support: winner?.[1] ?? 0, groups: groups.size };
  if (groups.size >= 2) return { count: winner[0], support: winner[1], groups: groups.size };

  // A one-LED strip cannot provide independent indices; test its count against shuffled slots.
  if (winner[0] === 1 && groups.has(0)) {
    const vote = groups.get(0).filter(v => v.count === 1).sort((a, b) => b.margin - a.margin)[0];
    const random = mulberry(7), margins = [];
    for (let n = 0; n < 32; n++) {
      const slots = vote.likelihoods.slice(20);
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
      margins.push(decodeCount([[...vote.likelihoods.slice(0, 20), ...slots]]).margin);
    }
    if (vote.margin > Math.max(...margins)) return { count: 1, support: 1, groups: 1 };
  }
  return { count: null, support: winner[1], groups: groups.size };
}

/** Margin threshold above which a decode is trusted: a high quantile of margins on shuffled slots. */
export function nullThreshold(allLikelihoods, { shuffles = 4, quantile = 0.999, seed = 7, limit = 10000 } = {}) {
  const random = mulberry(seed), margins = [];
  for (const l of allLikelihoods) {
    for (let r = 0; r < shuffles; r++) {
      const order = [...l.slice(0, 20)];
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      margins.push(decodeIndex([...order, ...l.slice(20)], limit).margin);
    }
  }
  margins.sort((a, b) => a - b);
  return margins[Math.min(margins.length - 1, Math.floor(quantile * margins.length))];
}

/**
 * Decodes every light of a stationary recording.
 * lights: array of sample lists [{time, features}] (time in ms).
 * Returns { period, count, lights: [{ index, margin, accepted }] }.
 */
export function decodeStationaryLights(lights, { temperature = 3, rounds = 5, calibrateOn = null, fillFrom = null, maxFill = 2 } = {}) {
  const period = PERIOD_MS;
  const folds = lights.map(samples => foldSamples(samples, period));
  // The color calibration may rely on a trusted subset while every light is decoded with the result.
  const trusted = calibrateOn ? calibrateOn.map(i => folds[i]) : folds;
  const calibration = findCalibration(trusted);
  let classifier = ColorClassifier.fromCenters(calibration.centers, calibration.assignment, trusted);
  let results = [], count = null, previous = null;
  for (let round = 0; round <= rounds; round++) {
    const likelihoods = folds.map(f => slotLikelihoods(f, calibration.rotation, classifier, temperature));
    const threshold = nullThreshold(likelihoods);
    results = likelihoods.map(l => {
      const { value, margin } = decodeIndex(l);
      return { index: value, margin, accepted: margin > threshold };
    });
    count = consensusCount(likelihoods, results).count;
    if (count !== null) results.forEach(r => { r.accepted = r.accepted && r.index < count; });
    // Stop once refitting no longer changes which lights decode to what.
    const signature = results.map(r => (r.accepted ? r.index : -1)).join(",");
    if (round === rounds || signature === previous) break;
    previous = signature;
    const training = [];
    folds.forEach((folded, i) => {
      if (!results[i].accepted) return;
      const expected = wordSymbols(results[i].index, INDEX_SYMBOLS).flatMap(v => [Math.floor(v / COLOR_COUNT), v % COLOR_COUNT]);
      for (let s = 0; s < INDEX_SYMBOLS * 2; s++) {
        const d = slotDescriptor(folded, calibration.rotation, s);
        if (d) training.push({ color: expected[s], features: d });
      }
    });
    if (training.length < 20) break;
    classifier = ColorClassifier.fit(training, classifier);
  }
  if (count >= 2 && count <= 2000) {
    const likelihoods = folds.map(f => slotLikelihoods(f, calibration.rotation, classifier, temperature));
    restrictToCount(results, likelihoods, count, fillFrom, maxFill);
  }
  return { period, rotation: calibration.rotation, count, calibrationScore: calibration.score, classifier, lights: results };
}

/**
 * Second pass once the count is known: only indices below it exist, so the weak lights are
 * decoded against that small set, which lowers the margin needed to trust a decode. Indices that
 * still have no light are then filled from the best remaining candidates (`fillFrom`: positions of
 * lights that may be used, default all), at most `maxFill` per index, and only when the missing
 * index is the light's top choice with a margin above a looser threshold. Edits `results` in place.
 */
function restrictToCount(results, likelihoods, count, fillFrom, maxFill) {
  const strict = nullThreshold(likelihoods, { limit: count });
  const loose = nullThreshold(likelihoods, { limit: count, quantile: 0.95 });
  const ranked = likelihoods.map(l => {
    const scores = indexScores(l, count);
    const order = scores.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    return { scores, best: order[0][1], margin: order[0][0] - order[1][0] };
  });
  ranked.forEach((r, i) => {
    if (!results[i].accepted && r.margin > strict) Object.assign(results[i], { index: r.best, margin: r.margin, accepted: true, restricted: true });
  });
  const found = new Set(results.filter(r => r.accepted).map(r => r.index));
  const eligible = new Set(fillFrom ?? results.map((_, i) => i));
  for (let missing = 0; missing < count; missing++) {
    if (found.has(missing)) continue;
    const candidates = ranked
      .map((r, i) => ({ i, r }))
      .filter(({ i, r }) => !results[i].accepted && eligible.has(i) && r.best === missing && r.margin > loose)
      .sort((a, b) => b.r.margin - a.r.margin)
      .slice(0, maxFill);
    for (const { i, r } of candidates) Object.assign(results[i], { index: missing, margin: r.margin, accepted: true, restricted: true, filled: true });
  }
}
