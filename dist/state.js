// @ts-check
// Scenario configuration: defaults, accepted ranges, and safe parsing of imported or shared scenarios.

/**
 * @typedef {object} Config
 * @property {number} nodes
 * @property {'Grid'|'Ring'|'Line'|'Random'} formation
 * @property {number} baselineM
 * @property {number} rangeKm
 * @property {number} freqGHz
 * @property {number} totalPowerW
 * @property {'Total fixed'|'Per node'} powerMode
 * @property {number} pathErrorMm
 * @property {number} rfPhaseRmsDeg
 * @property {number} freqOffsetHz
 * @property {number} velocityErrorMmS
 * @property {number} phaseWalkDegRtS
 * @property {'Estimated'|'Oracle'|'None'} command
 * @property {number} seed
 * @property {'Auto'|'Manual'} mapScale
 * @property {number} mapSpanKm
 * @property {number} lossTargetDb
 * @property {number} timeS
 */

export const SCHEMA = 'virtual-satellite-v0.3';

/** @type {Readonly<Config>} */
export const DEFAULTS = Object.freeze({
  nodes: 16,
  formation: 'Grid',
  baselineM: 500,
  rangeKm: 550,
  freqGHz: 20,
  totalPowerW: 320,
  powerMode: 'Total fixed',
  pathErrorMm: 0,
  rfPhaseRmsDeg: 0,
  freqOffsetHz: 0,
  velocityErrorMmS: 0,
  phaseWalkDegRtS: 0,
  command: 'Estimated',
  seed: 426,
  mapScale: 'Auto',
  mapSpanKm: 10,
  lossTargetDb: 1,
  timeS: 0,
});

/** @type {Record<string, [number, number]>} */
export const LIMITS = {
  nodes: [1, 64],
  baselineM: [1, 5000],
  rangeKm: [100, 50000],
  freqGHz: [0.1, 100],
  totalPowerW: [0.1, 100000],
  pathErrorMm: [0, 1000],
  rfPhaseRmsDeg: [0, 180],
  freqOffsetHz: [0, 10000],
  velocityErrorMmS: [0, 1000],
  phaseWalkDegRtS: [0, 360],
  seed: [0, 4294967295],
  mapSpanKm: [0.0001, 100],
  lossTargetDb: [0.01, 12],
  timeS: [0, 100],
};

/** @type {Record<string, string[]>} */
export const OPTIONS = {
  formation: ['Grid', 'Ring', 'Line', 'Random'],
  powerMode: ['Total fixed', 'Per node'],
  command: ['Estimated', 'Oracle', 'None'],
  mapScale: ['Auto', 'Manual'],
};

const INTEGER_KEYS = ['nodes', 'seed'];

/**
 * Merge `input` onto `base`, clamping numbers to LIMITS and accepting only listed options.
 * Anything else (wrong type, NaN, unknown option) keeps the base value.
 * @param {unknown} [input]
 * @param {Readonly<Config>} [base]
 * @returns {Config}
 */
export function normalizeConfig(input = {}, base = DEFAULTS) {
  /** @type {Record<string, any>} */
  const result = { ...base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return /** @type {Config} */ (result);
  /** @type {Record<string, unknown>} */
  const source = /** @type {any} */ (input);
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    result[key] = Math.min(max, Math.max(min, value));
    if (INTEGER_KEYS.includes(key)) result[key] = Math.round(result[key]);
  }
  for (const [key, options] of Object.entries(OPTIONS)) {
    const value = source[key];
    if (typeof value === 'string' && options.includes(value)) result[key] = value;
  }
  return /** @type {Config} */ (result);
}

/**
 * v0.2 files have no `mapScale`. Their 10 km default span under-samples the beam, so it moves to Auto;
 * a span the user changed on purpose stays Manual.
 * @param {Record<string, unknown>} scenario
 */
export function migrateScenario(scenario) {
  if (Object.hasOwn(scenario, 'mapScale') || typeof scenario.mapSpanKm !== 'number') return scenario;
  return { ...scenario, mapScale: scenario.mapSpanKm === DEFAULTS.mapSpanKm ? 'Auto' : 'Manual' };
}

/**
 * Only values that differ from DEFAULTS, so shared links stay short.
 * @param {Readonly<Config>} cfg
 */
export function configToParams(cfg) {
  const params = new URLSearchParams();
  for (const key of /** @type {(keyof Config)[]} */ (Object.keys(DEFAULTS))) {
    if (cfg[key] !== DEFAULTS[key]) params.set(key, String(cfg[key]));
  }
  return params;
}

/**
 * @param {URLSearchParams} params
 * @param {Readonly<Config>} [base]
 */
export function configFromParams(params, base = DEFAULTS) {
  /** @type {Record<string, unknown>} */
  const input = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(LIMITS, key) && value.trim() !== '') input[key] = Number(value);
    else if (Object.hasOwn(OPTIONS, key)) input[key] = value;
  }
  return normalizeConfig(input, base);
}

/** Wrap a phase in radians to (−180°, 180°]. @param {number} a */
export const phaseDegrees = a => Math.atan2(Math.sin(a), Math.cos(a)) * 180 / Math.PI;

/**
 * Mean coherence for independent zero-mean Gaussian phase errors: E[C] = 1/N + (1 − 1/N)·exp(−σ²).
 * @param {number} n
 * @param {number} phaseRmsDeg
 */
export const expectedCoherence = (n, phaseRmsDeg) => 1 / n + (1 - 1 / n) * Math.exp(-((phaseRmsDeg * Math.PI / 180) ** 2));
