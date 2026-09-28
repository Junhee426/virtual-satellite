import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,normalizeConfig,phaseDegrees,expectedCoherence} from '../dist/state.js';
import {metrics,requirement,focusMap,field} from '../dist/physics.js';

test('scenario imports clamp physical inputs and reject non-numeric or unknown values',()=>{
 const c=normalizeConfig({nodes:1000,rangeKm:-1,freqGHz:0,totalPowerW:Infinity,formation:'<script>',command:'constructor',timeS:'7',mapSpanKm:NaN});
 assert.equal(c.nodes,64);assert.equal(c.rangeKm,100);assert.equal(c.freqGHz,.1);
 assert.equal(c.totalPowerW,DEFAULTS.totalPowerW);assert.equal(c.formation,'Grid');
 assert.equal(c.command,'Estimated');assert.equal(c.timeS,0);assert.equal(c.mapSpanKm,10);
 assert.ok(Number.isFinite(metrics(c).coherence));
});
test('existing scenarios round-trip and malformed containers preserve defaults',()=>{
 assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(DEFAULTS))),DEFAULTS);
 for(const input of [null,[],false,'invalid'])assert.deepEqual(normalizeConfig(input),DEFAULTS);
 assert.equal(normalizeConfig({nodes:3.8}).nodes,4);
});
test('requirements curve crosses the requested loss at the reported phase RMS',()=>{
 for(const n of [2,16,64])for(const loss of [.1,1,2]){
  const r=requirement(n,loss,20);
  assert.ok(Math.abs(expectedCoherence(n,r.phaseRmsDeg)-10**(-loss/10))<1e-12);
 }
 assert.equal(expectedCoherence(1,180),1);
 assert.equal(requirement(1,1,20),null);
});
test('mean phase vector squared equals displayed coherence, including drift and RF errors',()=>{
 for(const command of ['Estimated','Oracle','None']){
  const m=metrics({...DEFAULTS,command,pathErrorMm:3,rfPhaseRmsDeg:20,freqOffsetHz:.35},.5);
  const re=m.phases.reduce((s,a)=>s+Math.cos(a),0)/m.phases.length;
  const im=m.phases.reduce((s,a)=>s+Math.sin(a),0)/m.phases.length;
  assert.ok(Math.abs(re*re+im*im-m.coherence)<1e-12);
  for(const a of m.phases)assert.ok(Math.abs(phaseDegrees(a))<=180);
 }
});
test('focus center and sampled horizontal cut retain the same physical normalization',()=>{
 const c={...DEFAULTS,formation:'Random',pathErrorMm:3,mapSpanKm:.1};
 const fm=focusMap(c,31),m=metrics(c);
 assert.ok(Math.abs(fm.values[15*31+15]-m.actual)<1e-8);
 assert.ok(Math.abs(fm.center-m.actual)<1e-8);
 assert.ok(Math.abs(fm.values[15*31]-field(c,m.truth,m.estimate,-50,0))<1e-8);
});
test('fast focus map matches the direct field model at every pixel',()=>{
 for(const c of [DEFAULTS,{...DEFAULTS,nodes:37,formation:'Ring',pathErrorMm:2,rfPhaseRmsDeg:15,freqOffsetHz:.4,powerMode:'Per node',command:'None'},{...DEFAULTS,nodes:5,formation:'Line',command:'Oracle',pathErrorMm:9,freqOffsetHz:3}]){
  const size=15,time=.37,fm=focusMap(c,size,time),m=metrics(c,time),half=c.mapSpanKm*500;
  for(let j=0;j<size;j++)for(let i=0;i<size;i++)assert.equal(fm.values[j*size+i],field(c,m.truth,m.estimate,-half+2*half*i/(size-1),-half+2*half*j/(size-1),time));
  assert.equal(fm.center,m.actual);
  assert.equal(fm.max,Math.max(...fm.values));
 }
});
