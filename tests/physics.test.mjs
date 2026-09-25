import test from 'node:test';import assert from 'node:assert/strict';import {wavelength,requirement,metrics,farFieldKm} from '../dist/physics.js';
const b={nodes:16,formation:'Grid',baselineM:500,rangeKm:550,freqGHz:20,totalPowerW:320,powerMode:'Total fixed',pathErrorMm:0,rfPhaseRmsDeg:0,freqOffsetHz:0,command:'Estimated',seed:426,mapSpanKm:10};
test('20GHz wavelength',()=>assert.ok(Math.abs(wavelength(20)*1000-14.9896)<.001));
test('ideal coherence',()=>{let m=metrics(b);assert.ok(Math.abs(m.coherence-1)<1e-12);assert.ok(Math.abs(m.gainVsIncoherentDb-12.0412)<.001)});
test('oracle cancels path estimate error',()=>assert.ok(Math.abs(metrics({...b,pathErrorMm:100,command:'Oracle'}).coherence-1)<1e-12));
test('1dB requirement',()=>{let r=requirement(16,1,20);assert.ok(Math.abs(r.phaseRmsDeg-28.514)<.02);assert.ok(Math.abs(r.pathRmsMm-1.187)<.01)});
test('far field scale',()=>assert.ok(Math.abs(farFieldKm(500,20)-33356)<10));
