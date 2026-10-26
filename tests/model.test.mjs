import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, configToParams, configFromParams, migrateScenario, expectedCoherence } from '../dist/state.js';
import {
  metrics, monteCarlo, phaseBudget, phaseWalk, quantilePhaseRms, quantileCurve, arrayScales, autoMapSpanKm,
  effectiveMapSpanKm, rng32, normal, TAU,
} from '../dist/physics.js';

test('Monte Carlo mean matches E[C] for the combined phase budget', () => {
  const c = { ...DEFAULTS, pathErrorMm: 0.5, rfPhaseRmsDeg: 10, freqOffsetHz: 0.2, velocityErrorMmS: 1, phaseWalkDegRtS: 20 };
  const time = 0.5, mc = monteCarlo(c, time, 3000), budget = phaseBudget(c, time);
  assert.ok(Math.abs(mc.mean - expectedCoherence(c.nodes, budget.total)) < 0.015, `${mc.mean} vs ${expectedCoherence(c.nodes, budget.total)}`);
  assert.ok(mc.p05 < mc.mean);
  assert.equal(phaseBudget({ ...c, command: 'Oracle' }, time).path, 0);
  assert.equal(phaseBudget({ ...c, command: 'None' }, time), null);
});

test('95% guarantee bound holds on independent draws and is stricter than the mean bound', () => {
  for (const n of [4, 16, 64]) {
    const s = quantilePhaseRms(n, 1), target = 10 ** -0.1, r = rng32(9001), trials = 4000, values = [];
    for (let k = 0; k < trials; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) {
        const a = s * normal(r);
        re += Math.cos(a);
        im += Math.sin(a);
      }
      values.push((re * re + im * im) / (n * n));
    }
    values.sort((a, b) => a - b);
    assert.ok(Math.abs(values[Math.floor(0.05 * trials)] - target) < 0.02, `n=${n}`);
    const meanBound = Math.sqrt(-Math.log((target - 1 / n) / (1 - 1 / n)));
    assert.ok(s < meanBound);
  }
  assert.equal(quantilePhaseRms(1, 1), null);
  const curve = quantileCurve(16);
  assert.equal(curve.length, 61);
  assert.equal(curve[0], 1);
});

test('phase random walk is reproducible, continuous in time and grows as D·√t', () => {
  const c = { ...DEFAULTS, nodes: 64, phaseWalkDegRtS: 30 };
  const late = phaseWalk(c, 2), early = phaseWalk(c, 0.5);
  phaseWalk({ ...c, seed: 1 }, 1);
  assert.deepEqual(phaseWalk(c, 0.5), early);
  assert.deepEqual(phaseWalk(c, 2), late);
  const a = phaseWalk(c, 1), b = phaseWalk(c, 1.0001);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.01);
  let sum = 0, count = 0;
  for (let seed = 0; seed < 60; seed++) for (const v of phaseWalk({ ...c, seed }, 1)) { sum += v * v; count++; }
  const rmsDeg = Math.sqrt(sum / count) * 180 / Math.PI;
  assert.ok(Math.abs(rmsDeg - 30) < 3, `${rmsDeg}`);
  assert.deepEqual(phaseWalk({ ...c, phaseWalkDegRtS: 0 }, 5), new Array(64).fill(0));
});

test('velocity error acts as a residual Doppler offset and leaves t = 0 unchanged', () => {
  const c = { ...DEFAULTS, rfPhaseRmsDeg: 5, command: 'Oracle' };
  assert.deepEqual(metrics({ ...c, velocityErrorMmS: 50 }).phases, metrics(c).phases);
  const k = TAU / (299792458 / 20e9), mc = monteCarlo({ ...c, rfPhaseRmsDeg: 0, velocityErrorMmS: 2 }, 1, 3000);
  assert.ok(Math.abs(mc.mean - expectedCoherence(16, k * 0.002 * 180 / Math.PI)) < 0.015);
});

test('focus map auto span resolves the beam and shows grating lobes', () => {
  const s = arrayScales(DEFAULTS);
  assert.ok(Math.abs(s.beamM - 16.49) < 0.01);
  assert.ok(Math.abs(s.gratingM - 49.46) < 0.01);
  assert.ok(autoMapSpanKm(DEFAULTS) * 1000 >= 2 * s.gratingM);
  assert.equal(arrayScales({ ...DEFAULTS, formation: 'Random' }).gratingM, null);
  for (const formation of ['Grid', 'Line', 'Ring', 'Random']) {
    for (const nodes of [2, 9, 16, 64]) {
      for (const [freqGHz, baselineM] of [[2, 50], [20, 500], [100, 5000]]) {
        const c = { ...DEFAULTS, formation, nodes, freqGHz, baselineM };
        const stepM = autoMapSpanKm(c) * 1000 / 120;
        assert.ok(stepM <= arrayScales(c).beamM / 3 + 1e-9, `${formation} ${nodes} ${freqGHz}`);
      }
    }
  }
  assert.equal(effectiveMapSpanKm({ ...DEFAULTS, mapScale: 'Manual', mapSpanKm: 3 }), 3);
});

test('URL parameters round-trip and ignore junk', () => {
  const cfg = { ...DEFAULTS, nodes: 7, formation: 'Ring', freqGHz: 2.4, velocityErrorMmS: 0.25, mapScale: 'Manual', seed: 4294967295 };
  const params = configToParams(cfg);
  assert.equal(params.has('rangeKm'), false);
  assert.deepEqual(configFromParams(new URLSearchParams(params.toString())), cfg);
  assert.deepEqual(configFromParams(new URLSearchParams('nodes=&formation=Hex&freqGHz=abc&tab=req&__proto__=1')), DEFAULTS);
  assert.equal(configFromParams(new URLSearchParams('nodes=999')).nodes, 64);
});

test('v0.2 scenarios migrate to the auto map span unless the span was customised', () => {
  assert.equal(migrateScenario({ schema: 'virtual-satellite-v0.1', mapSpanKm: 10 }).mapScale, 'Auto');
  assert.equal(migrateScenario({ schema: 'virtual-satellite-v0.1', mapSpanKm: 0.2 }).mapScale, 'Manual');
  assert.equal(migrateScenario({ mapScale: 'Auto', mapSpanKm: 0.2 }).mapScale, 'Auto');
});
