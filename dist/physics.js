// @ts-check
// Narrowband single-carrier model of a distributed satellite array focusing on a ground target.
// Satellites sit at z = range; the target is the origin of the z = 0 plane.

/** @typedef {import('./state.js').Config} Config */
/** @typedef {[number, number, number]} Vec3 */
/** @typedef {{phase: number, df: number}} NodeError */

export const C = 299792458;
export const TAU = 2 * Math.PI;

/** @param {number} x */
export const db10 = x => (x > 0 ? 10 * Math.log10(x) : -Infinity);
/** Wavelength in metres. @param {number} freqGHz */
export const wavelength = freqGHz => C / (freqGHz * 1e9);

/** mulberry32: small, fast, seedable uniform generator on [0, 1). @param {number} seed */
export function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box–Muller). @param {() => number} r */
export function normal(r) {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

/** @param {number} n */
const gridShape = n => {
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
};

/** True satellite positions in metres. @param {Config} c @returns {Vec3[]} */
export function formation(c) {
  const n = c.nodes, B = c.baselineM, z = c.rangeKm * 1000;
  /** @type {Vec3[]} */
  const p = [];
  if (n === 1) return [[0, 0, z]];
  if (c.formation === 'Ring') {
    for (let i = 0; i < n; i++) {
      const a = TAU * i / n;
      p.push([B / 2 * Math.cos(a), B / 2 * Math.sin(a), z]);
    }
  } else if (c.formation === 'Line') {
    for (let i = 0; i < n; i++) p.push([-B / 2 + B * i / (n - 1), 0, z]);
  } else if (c.formation === 'Random') {
    const r = rng32(c.seed), R = B / 2;
    for (let i = 0; i < n; i++) {
      const rr = R * Math.sqrt(r()), a = TAU * r();
      p.push([rr * Math.cos(a), rr * Math.sin(a), z]);
    }
  } else {
    const { cols, rows } = gridShape(n);
    const sx = cols > 1 ? B / (cols - 1) : 0, sy = rows > 1 ? B / (rows - 1) : 0;
    for (let i = 0; i < n; i++) p.push([-B / 2 + (i % cols) * sx, -B / 2 + Math.floor(i / cols) * sy, z]);
    // A partial last row shifts the bounding box, so re-centre it on the target.
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    p.forEach(q => { q[0] -= cx; q[1] -= cy; });
  }
  return p;
}

/** Estimated positions: the path-error RMS is applied along z (the line of sight). @param {Vec3[]} truth @param {Config} c */
export function estimates(truth, c, seed = c.seed + 101) {
  const r = rng32(seed), s = c.pathErrorMm / 1000;
  return truth.map(p => /** @type {Vec3} */ ([p[0], p[1], p[2] + normal(r) * s]));
}

/** @param {Vec3} a @param {Vec3} b */
const dist = (a, b) => {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
};

/** Steering phase each node applies to focus on `q`. @param {Vec3[]} truth @param {Vec3[]} est @param {Config} c @param {Vec3} [q] */
export function commands(truth, est, c, q = [0, 0, 0]) {
  const k = TAU / wavelength(c.freqGHz);
  return truth.map((p, i) => (c.command === 'None' ? 0 : k * dist(c.command === 'Oracle' ? p : est[i], q)));
}

/**
 * Per-node static RF phase error and frequency offset. A residual line-of-sight velocity error adds a
 * Doppler offset v/λ; it draws from its own stream so existing scenarios keep their realisations.
 * @param {Config} c
 * @returns {NodeError[]}
 */
export function errors(c, seed = c.seed + 202) {
  const r = rng32(seed), rv = rng32(seed + 202), s = c.rfPhaseRmsDeg * Math.PI / 180;
  const dopplerHz = c.velocityErrorMmS / 1000 / wavelength(c.freqGHz);
  return Array.from({ length: c.nodes }, () => ({
    phase: normal(r) * s,
    df: normal(r) * c.freqOffsetHz + normal(rv) * dopplerHz,
  }));
}

// Oscillator phase random walk (Brownian phase noise, D·√t RMS), sampled on a fixed grid so a
// given seed always produces the same path no matter which times are requested first.
const WALK_STEP_S = 0.01;
/** @type {{key: string, steps: number, sums: Float64Array, r: () => number}} */
let walkCache = { key: '', steps: 0, sums: new Float64Array(0), r: () => 0 };

/** @param {number} n @param {number} rateDegRtS @param {number} seed @param {number} steps */
function walkSums(n, rateDegRtS, seed, steps) {
  const key = `${n}|${rateDegRtS}|${seed}`;
  if (walkCache.key !== key) walkCache = { key, steps: 0, sums: new Float64Array(n * 64), r: rng32(seed) };
  if (walkCache.steps < steps) {
    if (walkCache.sums.length < (steps + 1) * n) {
      const grown = new Float64Array(Math.max((steps + 1) * n, walkCache.sums.length * 2));
      grown.set(walkCache.sums);
      walkCache.sums = grown;
    }
    const sums = walkCache.sums, sigma = rateDegRtS * Math.PI / 180 * Math.sqrt(WALK_STEP_S);
    for (let k = walkCache.steps + 1; k <= steps; k++) {
      for (let i = 0; i < n; i++) sums[k * n + i] = sums[(k - 1) * n + i] + normal(walkCache.r) * sigma;
    }
    walkCache.steps = steps;
  }
  return walkCache.sums;
}

/** Random-walk phase (radians) of each node at `time`. @param {Config} c @param {number} time */
export function phaseWalk(c, time, seed = c.seed + 303) {
  const n = c.nodes, out = new Array(n).fill(0);
  if (!(c.phaseWalkDegRtS > 0) || !(time > 0)) return out;
  const position = time / WALK_STEP_S, step = Math.floor(position), f = position - step;
  const sums = walkSums(n, c.phaseWalkDegRtS, seed, step + 1);
  for (let i = 0; i < n; i++) out[i] = sums[step * n + i] * (1 - f) + sums[(step + 1) * n + i] * f;
  return out;
}

/**
 * Residual phase of each node's signal at point `q`.
 * @param {Vec3[]} t @param {Vec3[]} e @param {Config} c @param {number} [time] @param {Vec3} [q]
 * @param {NodeError[]} [err] @param {number[]} [walk]
 */
export function phases(t, e, c, time = 0, q = [0, 0, 0], err = errors(c), walk = phaseWalk(c, time)) {
  const k = TAU / wavelength(c.freqGHz), cmd = commands(t, e, c, [0, 0, 0]);
  return t.map((p, i) => -k * dist(p, q) + cmd[i] + err[i].phase + TAU * err[i].df * time + walk[i]);
}

/** @param {Config} c */
const nodePower = c => (c.powerMode === 'Per node' ? c.totalPowerW : c.totalPowerW / c.nodes);

/** Coherently summed power of equal-amplitude phasors. @param {number[]} ph @param {number} p */
function summedPower(ph, p) {
  let re = 0, im = 0;
  for (const a of ph) {
    re += Math.sqrt(p) * Math.cos(a);
    im += Math.sqrt(p) * Math.sin(a);
  }
  return re * re + im * im;
}

/** Target-point metrics for one realisation. @param {Config} c */
export function metrics(c, time = 0) {
  const t = formation(c), e = estimates(t, c), ph = phases(t, e, c, time), n = t.length, p = nodePower(c);
  const actual = summedPower(ph, p), ideal = (n * Math.sqrt(p)) ** 2, incoh = n * p;
  return {
    truth: t,
    estimate: e,
    phases: ph,
    actual,
    ideal,
    incoh,
    coherence: actual / ideal,
    coherenceLossDb: actual ? -db10(actual / ideal) : Infinity,
    gainVsIncoherentDb: actual ? db10(actual / incoh) : -Infinity,
  };
}

/**
 * Summed power at ground point (x, y). Reference implementation for focusMap().
 * @param {Config} c @param {Vec3[]} t @param {Vec3[]} e @param {number} x @param {number} y
 */
export function field(c, t, e, x, y, time = 0, err = errors(c), walk = phaseWalk(c, time)) {
  return summedPower(phases(t, e, c, time, [x, y, 0], err, walk), nodePower(c));
}

/**
 * size × size power map over ±mapSpanKm/2. Same arithmetic as field(), with the per-node steering
 * command and error terms hoisted out of the pixel loop.
 * @param {Config} c
 */
export function focusMap(c, size = 71, time = 0) {
  const t = formation(c), e = estimates(t, c), err = errors(c), n = t.length, k = TAU / wavelength(c.freqGHz);
  const cmd = commands(t, e, c, [0, 0, 0]), ep = err.map(q => q.phase), dr = err.map(q => TAU * q.df * time);
  const wk = phaseWalk(c, time), amp = Math.sqrt(nodePower(c)), half = c.mapSpanKm * 500;
  const values = new Float64Array(size * size);
  /** @param {number} x @param {number} y */
  const at = (x, y) => {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const p = t[i], dx = p[0] - x, dy = p[1] - y, dz = p[2] - 0;
      const a = -k * Math.sqrt(dx * dx + dy * dy + dz * dz) + cmd[i] + ep[i] + dr[i] + wk[i];
      re += amp * Math.cos(a);
      im += amp * Math.sin(a);
    }
    return re * re + im * im;
  };
  let max = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const z = at(-half + 2 * half * i / (size - 1), -half + 2 * half * j / (size - 1));
      values[j * size + i] = z;
      max = Math.max(max, z);
    }
  }
  return { size, values, max, center: at(0, 0), half };
}

/**
 * Ground-plane scales of the focused pattern (small-angle): main-beam width λR/B and, for periodic
 * formations, the distance from the target to the nearest grating lobe λR/d along each axis.
 * @param {Config} c
 */
export function arrayScales(c) {
  const lambda = wavelength(c.freqGHz), R = c.rangeKm * 1000, B = c.baselineM;
  let spacingX = 0, spacingY = 0;
  if (c.nodes > 1 && c.formation === 'Line') spacingX = B / (c.nodes - 1);
  if (c.nodes > 1 && c.formation === 'Grid') {
    const { cols, rows } = gridShape(c.nodes);
    spacingX = cols > 1 ? B / (cols - 1) : 0;
    spacingY = rows > 1 ? B / (rows - 1) : 0;
  }
  const gratingXM = spacingX ? lambda * R / spacingX : null, gratingYM = spacingY ? lambda * R / spacingY : null;
  const nearest = [gratingXM, gratingYM].filter(v => v !== null);
  return { beamM: lambda * R / B, gratingXM, gratingYM, gratingM: nearest.length ? Math.min(...nearest) : null };
}

/**
 * Map width that resolves the main beam (≥ 3 samples per beam width) and, when it fits, shows the
 * neighbouring grating lobes. A fixed wide span aliases the pattern into a meaningless moiré.
 * @param {Config} c
 */
export function autoMapSpanKm(c, size = 121) {
  const { beamM, gratingM } = arrayScales(c);
  let span = 8 * beamM;
  if (gratingM) span = Math.max(span, 2.5 * gratingM);
  span = Math.min(span, beamM * (size - 1) / 3);
  return Math.min(100, Math.max(0.0001, span / 1000));
}

/** @param {Config} c */
export const effectiveMapSpanKm = (c, size = 121) => (c.mapScale === 'Manual' ? c.mapSpanKm : autoMapSpanKm(c, size));

/**
 * Independent Gaussian phase-error contributions in degrees RMS at `time`, and their root-sum-square.
 * Without steering (command None) the residual is geometric, not random, so there is no budget.
 * @param {Config} c
 */
export function phaseBudget(c, time = 0) {
  if (c.command === 'None') return null;
  const k = TAU / wavelength(c.freqGHz), deg = 180 / Math.PI;
  const parts = {
    path: c.command === 'Estimated' ? k * c.pathErrorMm / 1000 * deg : 0,
    rf: c.rfPhaseRmsDeg,
    drift: TAU * c.freqOffsetHz * time * deg,
    doppler: k * c.velocityErrorMmS / 1000 * time * deg,
    walk: c.phaseWalkDegRtS * Math.sqrt(time),
  };
  return { ...parts, total: Math.hypot(...Object.values(parts)) };
}

/** @param {Float64Array} sorted @param {number} q */
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** @param {number[]} ph */
function coherenceOf(ph) {
  let re = 0, im = 0;
  for (const a of ph) {
    re += Math.cos(a);
    im += Math.sin(a);
  }
  return (re * re + im * im) / (ph.length * ph.length);
}

/**
 * Coherence distribution over `trials` independent error realisations of the current scenario
 * (the formation itself is kept). p05 is the value exceeded with 95 % probability.
 * @param {Config} c
 */
export function monteCarlo(c, time = 0, trials = 400) {
  const t = formation(c), values = new Float64Array(trials);
  const walkSigma = c.phaseWalkDegRtS * Math.PI / 180 * Math.sqrt(time);
  for (let k = 0; k < trials; k++) {
    const seed = (c.seed + 7919 * (k + 1)) >>> 0, wr = rng32(seed + 303);
    const walk = t.map(() => normal(wr) * walkSigma);
    values[k] = coherenceOf(phases(t, estimates(t, c, seed + 101), c, time, [0, 0, 0], errors(c, seed + 202), walk));
  }
  values.sort();
  const mean = values.reduce((s, v) => s + v, 0) / trials, p05 = quantile(values, 0.05);
  return { trials, mean, p05, meanLossDb: -db10(mean), p05LossDb: -db10(p05) };
}

/** @param {number} count @param {number} seed */
function gaussianDraws(count, seed) {
  const r = rng32(seed), z = new Float64Array(count);
  for (let i = 0; i < count; i++) z[i] = normal(r);
  return z;
}

/** q-quantile of coherence when every node has phase error σ·Z. @param {Float64Array} z @param {number} n @param {number} sigma @param {number} q */
function coherenceQuantile(z, n, sigma, q) {
  const trials = z.length / n, values = new Float64Array(trials);
  for (let k = 0; k < trials; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const a = sigma * z[k * n + i];
      re += Math.cos(a);
      im += Math.sin(a);
    }
    values[k] = (re * re + im * im) / (n * n);
  }
  return quantile(values.sort(), q);
}

/**
 * Phase RMS (radians) at which the q-quantile of coherence meets the loss target, i.e. the loss is
 * met with probability 1 − q. Uses common random numbers so the quantile is smooth in σ.
 * @param {number} n @param {number} lossDb
 * @returns {number|null} null when no finite bound exists within π.
 */
export function quantilePhaseRms(n, lossDb, q = 0.05, trials = 1000, seed = 426) {
  if (n < 2) return null;
  const target = 10 ** (-lossDb / 10), z = gaussianDraws(n * trials, seed);
  if (coherenceQuantile(z, n, Math.PI, q) >= target) return null;
  let lo = 0, hi = Math.PI;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (coherenceQuantile(z, n, mid, q) >= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** q-quantile of coherence at phase RMS 0°, 3°, …, 180°. @param {number} n */
export function quantileCurve(n, q = 0.05, trials = 600, seed = 426) {
  const z = gaussianDraws(n * trials, seed), curve = [];
  for (let deg = 0; deg <= 180; deg += 3) curve.push(coherenceQuantile(z, n, deg * Math.PI / 180, q));
  return curve;
}

/** Equivalent path and timing precision of a phase RMS. @param {number} s radians @param {number} f GHz */
export function precisionFromPhase(s, f) {
  const lam = wavelength(f);
  return { phaseRmsDeg: s * 180 / Math.PI, pathRmsMm: s * lam / TAU * 1000, timeRmsPs: s / (TAU * f * 1e9) * 1e12 };
}

/** Phase/path RMS that meets the mean-coherence loss target. @param {number} n @param {number} loss @param {number} f */
export function requirement(n, loss, f) {
  const target = 10 ** (-loss / 10), x = (target - 1 / n) / (1 - 1 / n);
  if (x <= 0 || x > 1) return null;
  return precisionFromPhase(Math.sqrt(-Math.log(x)), f);
}

/** Far-field scale 2B²/λ in km. @param {number} B @param {number} f */
export const farFieldKm = (B, f) => 2 * B * B / wavelength(f) / 1000;
