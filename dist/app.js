import {metrics,focusMap,requirement,farFieldKm,wavelength} from './physics.js';
import {DEFAULTS,LIMITS,normalizeConfig,phaseDegrees,expectedCoherence} from './state.js';

let cfg={...DEFAULTS},tab='formation',selected=0,playing=false,frame=0,previous=0;
let cachedMap=null,mapKey='';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const fmt=(x,d=2)=>Number.isFinite(x)?(Math.abs(x)<.5*10**-d?0:x).toFixed(d):x===Infinity?'∞':x===-Infinity?'−∞':'—';
const names={Grid:'격자',Ring:'원형',Line:'선형',Random:'무작위',Estimated:'추정 위치로 보정',Oracle:'실제 위치로 보정',None:'보정 없음','Total fixed':'전체 전력 고정','Per node':'위성당 전력 고정'};
const phaseColor=a=>{const t=Math.abs(phaseDegrees(a))/180;return `hsl(${165-135*t} 65% 68%)`};
const line=(x1,y1,x2,y2,color='#283b4d',extra='')=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ${extra}/>`;
const text=(x,y,value,extra='')=>`<text x="${x}" y="${y}" ${extra}>${value}</text>`;
const circle=(x,y,r,color,extra='')=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" ${extra}/>`;
const svg=(body,label,view='0 0 640 440')=>`<svg class="chart" viewBox="${view}" role="img" aria-label="${label}">${body}</svg>`;
const field=(k,label,step,unit='',slider=false)=>`<div class="field"><label for="f-${k}">${label}<span>${unit}</span></label><input id="f-${k}" data-key="${k}" type="number" min="${LIMITS[k][0]}" max="${LIMITS[k][1]}" step="${step}" value="${cfg[k]}">${slider?`<input type="range" data-range="${k}" min="${LIMITS[k][0]}" max="${LIMITS[k][1]}" step="${step}" value="${cfg[k]}" aria-label="${label} 슬라이더">`:''}</div>`;
const select=(k,label,options)=>`<div class="field"><label for="f-${k}">${label}</label><select id="f-${k}" data-key="${k}">${options.map(v=>`<option value="${v}" ${cfg[k]===v?'selected':''}>${names[v]}</option>`).join('')}</select></div>`;
function controls(){
 $('#controls').innerHTML=`<div class="group"><h3><b>01</b> CONSTELLATION</h3>${field('nodes','위성 수',1,'대',true)}${select('formation','배치 형태',['Grid','Ring','Line','Random'])}<div class="pair">${field('baselineM','배열 크기 B',1,'m')}${field('rangeKm','목표 거리',1,'km')}</div><p class="hint">B는 배치 생성 기준 길이입니다.<br>격자 배열의 대각선 길이는 B보다 큽니다.</p></div>
 <div class="group"><h3><b>02</b> RADIO FREQUENCY</h3>${field('freqGHz','반송파 주파수',.1,'GHz')}<div class="quick">${[2,20,30].map(f=>`<button data-freq="${f}" aria-pressed="${cfg.freqGHz===f}">${f} GHz</button>`).join('')}</div><div style="margin-top:14px">${field('totalPowerW',cfg.powerMode==='Per node'?'위성당 RF 전력':'전체 RF 전력',1,'W')}${select('powerMode','전력 기준',['Total fixed','Per node'])}</div></div>
 <div class="group"><h3><b>03</b> PHASE & ERRORS</h3>${select('command','위상 보정',['Estimated','Oracle','None'])}<div class="pair">${field('pathErrorMm','경로 오차 RMS',.1,'mm')}${field('rfPhaseRmsDeg','RF 위상 RMS',.1,'°')}</div><div class="pair">${field('freqOffsetHz','주파수 오차',.01,'Hz RMS')}${field('timeS','경과 시간',.001,'s')}</div></div>
 <div class="group"><h3><b>04</b> OBSERVATION</h3>${field('lossTargetDb','평균 손실 목표',.01,'dB')}${tab==='focus'?field('mapSpanKm','초점 지도 폭','any','km'):''}<p class="hint">같은 설정에서는 같은 난수 시드로 비교합니다. 경로 RMS는 3D 위치 오차와 다릅니다.</p></div>`;
 $$('[data-key]').forEach(el=>{el.onchange=()=>{
  stop();const key=el.dataset.key;
  cfg=normalizeConfig({[key]:el.tagName==='SELECT'?el.value:Number(el.value)},cfg);
  el.value=cfg[key];const range=$(`[data-range="${key}"]`);if(range)range.value=cfg[key];
  if(key==='powerMode')controls();
  $$('[data-freq]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.freq)===cfg.freqGHz)));
  clearPreset();render();
 };if(el.tagName==='INPUT')el.oninput=()=>{
  const value=Number(el.value),[min,max]=LIMITS[el.dataset.key];
  if(el.value.trim()!==''&&Number.isFinite(value)&&value>=min&&value<=max)el.onchange();
 };});
 $$('[data-range]').forEach(el=>el.oninput=()=>{stop();cfg=normalizeConfig({[el.dataset.range]:Number(el.value)},cfg);$('#f-'+el.dataset.range).value=cfg[el.dataset.range];clearPreset();render()});
 $$('[data-freq]').forEach(b=>b.onclick=()=>{stop();cfg.freqGHz=Number(b.dataset.freq);clearPreset();controls();render()});
}
const info={
 formation:['편대의 모양과 신호 상태','위성을 선택해 위치와 목표점에서의 잔여 위상을 확인하세요.','TOP VIEW'],
 focus:['신호가 모이는 곳','밝을수록 강한 신호입니다. 십자선은 목표점을 나타냅니다.','FOCUS MAP'],
 sync:['같은 방향일수록, 강한 신호','얇은 선은 위성별 위상, 굵은 화살표는 평균 합성 벡터입니다.','PHASE VIEW'],
 req:['얼마나 정확하게 맞춰야 할까?','평균 결맞음 손실 목표를 등가 경로·위상 정밀도로 바꿉니다.','REQUIREMENT']
};
function summary(m){
 const coherence=Math.min(100,Math.max(0,m.coherence*100)),ok=m.coherenceLossDb<=cfg.lossTargetDb;
 $('#summary').innerHTML=`<div class="metric primary"><div class="metric-label">신호가 모이는 정도 <em>${ok?'목표 손실 이내':'목표 손실 초과'}</em></div><div class="metric-value">${fmt(coherence,1)}<small>%</small></div><div class="meter" aria-hidden="true"><i style="width:${coherence}%"></i></div><p>이상적으로 정렬된 신호 전력 대비</p></div><div class="metric"><div class="metric-label">결맞음 손실</div><div class="metric-value">${fmt(m.coherenceLossDb)}<small>dB</small></div><p>낮을수록 좋음 · 목표 ${cfg.lossTargetDb} dB</p></div><div class="metric"><div class="metric-label">비결맞음 대비 이득</div><div class="metric-value">${m.gainVsIncoherentDb>=0?'+':''}${fmt(m.gainVsIncoherentDb)}<small>dB</small></div><p>같은 위성 수 · 같은 총 전력 기준</p></div>`;
}
function results(m){
 const r=requirement(cfg.nodes,cfg.lossTargetDb,cfg.freqGHz),ok=m.coherenceLossDb<=cfg.lossTargetDb;
 const explanation=cfg.nodes===1?'위성이 하나면 위상 상쇄가 없습니다. 여러 위성을 배치해 합성 효과를 비교하세요.':ok?'위성들의 신호가 목표점에서 잘 합쳐지고 있습니다. 경로 오차를 높여 신호가 흩어지는 모습을 비교해 보세요.':'위성 간 위상 차이로 신호가 서로 상쇄됩니다. 경로·RF·주파수 오차와 보정 방식을 확인하세요.';
 $('#results').innerHTML=`<section class="inspector-card"><h3>READING THE SIGNAL</h3><h4 class="verdict ${ok?'':'caution'}">${ok?'신호가 잘 모이고 있어요':'신호가 흩어지고 있어요'}</h4><p>${explanation}</p><div class="phase-strip" aria-label="위성별 잔여 위상">${m.phases.map((a,i)=>`<i style="background:${phaseColor(a)}" title="위성 ${i+1}: ${fmt(phaseDegrees(a),1)}°"></i>`).join('')}</div><button class="inspector-link" data-goto="${tab==='sync'?'focus':'sync'}">${tab==='sync'?'초점 지도 확인':'위상 벡터 확인'} ↗</button></section>
 <section class="inspector-card"><h3>SCENARIO SNAPSHOT</h3><dl><div><dt>편대</dt><dd>${names[cfg.formation]} · ${cfg.nodes}대</dd></div><div><dt>배열 크기</dt><dd>${cfg.baselineM} m</dd></div><div><dt>목표 거리</dt><dd>${cfg.rangeKm} km</dd></div><div><dt>파장</dt><dd>${fmt(wavelength(cfg.freqGHz)*1000,3)} mm</dd></div><div><dt>전체 RF 전력</dt><dd>${fmt(cfg.totalPowerW*(cfg.powerMode==='Per node'?cfg.nodes:1),1)} W</dd></div><div><dt>원거리장 척도</dt><dd title="2B²/λ · 엄밀 경계가 아닌 척도">${fmt(farFieldKm(cfg.baselineM,cfg.freqGHz),0)} km</dd></div><div><dt>경과 시간</dt><dd>${fmt(cfg.timeS,3)} s</dd></div></dl></section>
 <section class="inspector-card"><h3>PRECISION GUIDE</h3><p>평균 ${cfg.lossTargetDb} dB 손실에 해당하는<br>등가 단방향 경로 RMS</p><div class="big">${r?fmt(r.pathRmsMm,3):'—'} <small>mm</small></div><p>${r?`위상 RMS ${fmt(r.phaseRmsDeg,2)}°<br>고주파일수록 더 정밀한 보정이 필요합니다.`:'현재 조건에는 유한한 RMS 경계가 없습니다.'}</p><button class="inspector-link" data-goto="req">요구 조건 살펴보기 ↗</button></section>`;
 $$('[data-goto]').forEach(b=>b.onclick=()=>switchTab(b.dataset.goto));
}
function formationView(m){
 const cx=320,cy=207,scale=300/cfg.baselineM;
 let h='';
 for(let i=-2;i<=2;i++){
  const p=i*75;h+=line(135,cy+p,505,cy+p,'#22303e')+line(cx+p,35,cx+p,380,'#22303e');
  h+=text(122,cy+p+4,fmt(-i*cfg.baselineM/4,0),'text-anchor="end"')+text(cx+p,401,fmt(i*cfg.baselineM/4,0),'text-anchor="middle"');
 }
 h+=line(cx,32,cx,381,'#486171','stroke-dasharray="3 5"')+line(133,cy,507,cy,'#486171','stroke-dasharray="3 5"');
 h+=text(512,224,'x / m','class="axis-title"')+text(330,28,'y / m','class="axis-title"');
 if(cfg.formation==='Ring')h+=circle(cx,cy,150,'none','stroke="#365a5c" stroke-dasharray="4 7"');
 h+=circle(cx,cy,7,'none','stroke="#e6eeda"')+line(cx-12,cy,cx+12,cy,'#e6eeda')+line(cx,cy-12,cx,cy+12,'#e6eeda');
 m.truth.forEach((p,i)=>{
  const x=cx+p[0]*scale,y=cy-p[1]*scale,color=phaseColor(m.phases[i]),r=cfg.nodes>36?11:15;
  h+=`<g class="node" data-node="${i}" tabindex="0" role="button" aria-label="위성 ${i+1}, 잔여 위상 ${fmt(phaseDegrees(m.phases[i]),1)}도" aria-pressed="${selected===i}"><title>위성 ${i+1} · ${fmt(phaseDegrees(m.phases[i]),1)}°</title>${circle(x,y,r+6,'transparent',`class="node-ring" stroke="${selected===i?'#d7fff4':'transparent'}"`)}${line(x-13,y,x+13,y,color,'stroke-width="2"')}${`<rect x="${x-14}" y="${y-5}" width="8" height="10" rx="1" fill="${color}" opacity=".6"/><rect x="${x+6}" y="${y-5}" width="8" height="10" rx="1" fill="${color}" opacity=".6"/><rect x="${x-4}" y="${y-5}" width="8" height="10" rx="2" fill="${color}"/>`}${text(x,y+29,String(i+1).padStart(2,'0'),'text-anchor="middle" class="node-label"')}</g>`;
 });
 $('#visual').innerHTML=svg(h,'위성 편대의 평면 배치와 위성별 위상. 각 위성을 선택할 수 있습니다.')+`<div class="legend-row"><span><i class="legend-key"></i>0°에 가까움</span><span><i class="legend-key amber"></i>±180°에 가까움</span><span>⊕ 목표점의 평면 투영</span></div><div id="node-info" class="node-info"></div>`;
 updateNodeInfo(m);
 $$('[data-node]').forEach(el=>{
  const pick=()=>{selected=Number(el.dataset.node);formationView(m)};
  el.onclick=pick;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selected=Number(el.dataset.node);updateNodeInfo(m);$$('[data-node]').forEach(n=>{const active=Number(n.dataset.node)===selected;n.setAttribute('aria-pressed',String(active));n.querySelector('.node-ring').setAttribute('stroke',active?'#d7fff4':'transparent')})}};
 });
 $('#view-note').innerHTML='<b>읽는 법</b> 아이콘은 실제 크기가 아닙니다. 색은 목표점에서의 잔여 위상입니다. 경로 추정 오차는 깊이(z) 방향에 적용되어 평면 위치에는 나타나지 않습니다.';
}
function updateNodeInfo(m){
 const p=m.truth[selected],e=m.estimate[selected];
 $('#node-info').innerHTML=`<strong>위성 ${String(selected+1).padStart(2,'0')}</strong><span>x ${fmt(p[0],1)} / y ${fmt(p[1],1)} m</span><span>경로방향 Δz ${fmt((e[2]-p[2])*1000,3)} mm</span><span>잔여 위상 ${fmt(phaseDegrees(m.phases[selected]),1)}°</span>`;
}
function palette(t){
 const stops=[[16,25,41],[48,71,135],[50,127,156],[119,218,195],[244,230,161]],v=Math.max(0,Math.min(1,t))*4,i=Math.min(3,Math.floor(v)),f=v-i;
 return stops[i].map((a,k)=>Math.round(a+(stops[i+1][k]-a)*f));
}
function focusView(){
 const key=JSON.stringify(cfg);
 if(mapKey!==key){cachedMap=focusMap(cfg,121,cfg.timeS);mapKey=key}
 const fm=cachedMap,off=document.createElement('canvas');off.width=off.height=fm.size;
 const ctx=off.getContext('2d'),img=ctx.createImageData(fm.size,fm.size),db=v=>Math.max(-35,10*Math.log10(Math.max(v/fm.max,1e-12)));
 fm.values.forEach((v,i)=>{img.data.set([...palette((db(v)+35)/35),255],((fm.size-1-Math.floor(i/fm.size))*fm.size+i%fm.size)*4)});ctx.putImageData(img,0,0);
 let h=`<image href="${off.toDataURL()}" x="130" y="20" width="380" height="380" style="image-rendering:pixelated"/>`;
 for(let i=0;i<=4;i++){
  const p=130+i*95,q=20+i*95,label=fmt((i/4-.5)*cfg.mapSpanKm,cfg.mapSpanKm<.1?4:2);
  h+=text(p,423,label,'text-anchor="middle"')+text(117,q+4,fmt((.5-i/4)*cfg.mapSpanKm,cfg.mapSpanKm<.1?4:2),'text-anchor="end"');
 }
 h+=line(130,210,510,210,'#d7eee3','stroke-dasharray="4 5" opacity=".6"')+line(320,20,320,400,'#d7eee3','stroke-dasharray="4 5" opacity=".6"');
 h+=circle(320,210,9,'none','stroke="#fff" stroke-width="1.5"')+text(334,199,'목표점','style="fill:#fff"')+text(550,438,'x / km')+text(131,12,'y / km');
 const scaleHint=wavelength(cfg.freqGHz)*cfg.rangeKm/Math.max(cfg.baselineM,1),stepKm=cfg.mapSpanKm/(fm.size-1),undersampled=stepKm>scaleHint/3;
 let curve='';
 for(let i=0;i<fm.size;i++){const x=65+i/(fm.size-1)*530,y=36-db(fm.values[60*fm.size+i])/35*91;curve+=`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)} `}
 let cut='';
 [0,-10,-20,-30].forEach(v=>{let y=36-v/35*91;cut+=line(65,y,595,y,'#263644')+text(53,y+4,v,'text-anchor="end"')});
 cut+=`<path d="${curve}" fill="none" stroke="#77e4c7" stroke-width="1.8"/>`+line(330,30,330,133,'#9caebc','stroke-dasharray="3 4"')+text(65,155,fmt(-cfg.mapSpanKm/2,cfg.mapSpanKm<.1?4:2)+' km')+text(595,155,fmt(cfg.mapSpanKm/2,cfg.mapSpanKm<.1?4:2)+' km','text-anchor="end"')+text(330,155,'목표점','text-anchor="middle"');
 $('#visual').innerHTML=svg(h,'목표점 주변 신호 전력 지도, 지도 최댓값 기준 데시벨')+`<div class="color-scale"><span>−35 dB</span><i></i><span>0 dB</span></div><div class="section-caption"><span>가로 단면 · y = 0</span><button id="zoomFocus" class="text-button">중앙 빔 확대 ↗</button></div>`+svg(cut,'초점 지도의 중앙 가로 단면','0 0 640 175');
 $('#zoomFocus').onclick=()=>{cfg.mapSpanKm=Math.max(.0001,Math.min(100,scaleHint*8));controls();render()};
 $('#view-note').innerHTML=`<b>${undersampled?'넓은 범위 · 좁은 빔 확인 시 확대하세요':'목표점 주변 확대 보기'}</b> 색과 단면은 지도 최댓값을 0 dB로 정규화합니다. 121 × 121 격자는 좁은 피크를 놓칠 수 있습니다. 실제 목표점 결맞음은 상단 수치를 확인하세요.`;
}
function arrow(x1,y1,x2,y2,color,width=2){
 const a=Math.atan2(y2-y1,x2-x1),r=9;
 if(Math.hypot(x2-x1,y2-y1)<1)return circle(x1,y1,3,color);
 return line(x1,y1,x2,y2,color,`stroke-width="${width}" stroke-linecap="round"`)+`<path d="M${x2-r*Math.cos(a-.5)},${y2-r*Math.sin(a-.5)} L${x2},${y2} L${x2-r*Math.cos(a+.5)},${y2-r*Math.sin(a+.5)}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
}
function syncView(m){
 const cx=320,cy=198,r=144;let h='';
 [.5,1].forEach(k=>h+=circle(cx,cy,r*k,'none','stroke="#2b3e4e" stroke-dasharray="3 5"'));
 h+=line(cx-r-22,cy,cx+r+22,cy)+line(cx,cy-r-20,cx,cy+r+20);
 h+=text(cx+r+25,cy+4,'0°')+text(cx,cy-r-24,'90°','text-anchor="middle"')+text(cx-r-26,cy+4,'±180°','text-anchor="end"')+text(cx,cy+r+28,'−90°','text-anchor="middle"');
 let re=0,im=0;
 m.phases.forEach(a=>{re+=Math.cos(a)/cfg.nodes;im+=Math.sin(a)/cfg.nodes;const ex=cx+r*Math.cos(a),ey=cy-r*Math.sin(a);h+=line(cx,cy,ex,ey,phaseColor(a),'stroke-width="1.4" opacity=".55"')+circle(ex,ey,3,phaseColor(a))});
 h+=arrow(cx,cy,cx+r*re,cy-r*im,'#eefcf8',4)+circle(cx,cy,4,'#eefcf8');
 h+=text(cx,399,`평균 벡터 길이 ${fmt(Math.sqrt(m.coherence),3)} → 신호 전력 ${fmt(m.coherence*100,1)}%`,'text-anchor="middle" class="svg-value"');
 const plot=svg(h,'위성별 잔여 위상과 평균 합성 벡터');
 if($('#phase-plot')){$('#phase-plot').innerHTML=plot;$('#play').textContent=playing?'Ⅱ 일시정지':'▷ 재생';$('#play').setAttribute('aria-pressed',String(playing));$('#timeline').value=Math.min(2,cfg.timeS);$('.playback output').value=fmt(cfg.timeS,3)+' s'}
 else $('#visual').innerHTML='<div id="phase-plot">'+plot+'</div>'+`<div class="legend-row"><span><i class="legend-key"></i>위성별 위상</span><span>↗ 흰색: 평균 합성 벡터</span><span>벡터 길이² = 결맞음 계수</span></div><div class="playback"><button id="play" aria-pressed="${playing}">${playing?'Ⅱ 일시정지':'▷ 재생'}</button><input id="timeline" aria-label="시간 탐색" type="range" min="0" max="2" step=".001" value="${Math.min(2,cfg.timeS)}"><output>${fmt(cfg.timeS,3)} s</output></div>`;
 $('#play').onclick=()=>{if(playing){stop();render()}else{if(cfg.timeS>=2)cfg.timeS=0;playing=true;previous=0;render();frame=requestAnimationFrame(tick)}};
 $('#timeline').oninput=e=>{stop();cfg.timeS=Number(e.target.value);$('#f-timeS').value=cfg.timeS;clearPreset();render()};
 $('#view-note').innerHTML=`<b>시간 탐색 · 0–2초</b> 주파수 오차가 있으면 시간이 흐르며 화살표가 벌어집니다. 오차가 0이면 정지해 보이는 것이 정상입니다. 높은 주파수 오차는 화면 갱신 사이 변화를 모두 보여주지 못합니다.`;
}
function tick(now){
 if(!playing)return;
 if(!previous)previous=now;
 if(now-previous>=80){cfg.timeS=Math.min(2,cfg.timeS+(now-previous)/1000);previous=now;if(cfg.timeS>=2)playing=false;$('#f-timeS').value=fmt(cfg.timeS,3);render()}
 if(playing)frame=requestAnimationFrame(tick);
}
function stop(){playing=false;cancelAnimationFrame(frame)}
function reqView(){
 const r=requirement(cfg.nodes,cfg.lossTargetDb,cfg.freqGHz),target=10**(-cfg.lossTargetDb/10);
 let h='';
 for(let i=0;i<=4;i++){let y=35+i*45;h+=line(65,y,594,y)+text(53,y+4,100-i*25+'%','text-anchor="end"')}
 for(let i=0;i<=6;i++)h+=text(65+i/6*529,240,i*30+'°','text-anchor="middle"');
 let path='';for(let i=0;i<=180;i++)path+=`${i?'L':'M'}${65+i/180*529},${215-expectedCoherence(cfg.nodes,i)*180} `;
 h+=`<path d="${path}" fill="none" stroke="#77e4c7" stroke-width="2.5"/>`;
 const y=215-target*180;h+=line(65,y,594,y,'#f3bc72','stroke-dasharray="5 5"')+text(586,y+15,`목표 ${fmt(target*100,1)}%`,'text-anchor="end" style="fill:#f3bc72"');
 if(r&&r.phaseRmsDeg<=180){const x=65+r.phaseRmsDeg/180*529;h+=line(x,35,x,215,'#83b6ff','stroke-dasharray="4 5"')+circle(x,y,5,'#83b6ff')+text(Math.min(x+10,490),34,fmt(r.phaseRmsDeg,2)+'°','style="fill:#83b6ff"')}
 h+=text(65,18,'평균 결맞음 계수')+text(594,263,'위성별 위상 오차 RMS','text-anchor="end"');
 const freqs=[...new Set([2,20,30,cfg.freqGHz])].sort((a,b)=>a-b);
 $('#visual').innerHTML=`<div class="req-intro">${r?`경로 오차 RMS <strong>${fmt(r.pathRmsMm,3)}</strong> mm<br><span class="hint">위상 ${fmt(r.phaseRmsDeg,2)}° · 등가 시간 ${fmt(r.timeRmsPs,3)} ps</span>`:'현재 조건에서는 유한한 RMS 경계가 정의되지 않습니다.'}</div>`+svg(h,'위상 오차 RMS에 따른 평균 결맞음 계수와 목표 손실','0 0 640 280')+`<table class="compare-table"><thead><tr><th>반송파</th><th>파장</th><th>등가 경로 RMS</th></tr></thead><tbody>${freqs.map(f=>{let q=requirement(cfg.nodes,cfg.lossTargetDb,f);return `<tr class="${f===cfg.freqGHz?'current':''}"><td>${f} GHz ${f===cfg.freqGHz?'· 현재':''}</td><td>${fmt(wavelength(f)*1000,2)} mm</td><td>${q?fmt(q.pathRmsMm,3)+' mm':'경계 없음'}</td></tr>`}).join('')}</tbody></table>`;
 $('#view-note').innerHTML='<b>모델 가정</b> 독립적인 0 평균 가우시안 위상 오차, 같은 채널 진폭. E[C] = 1/N + (1 − 1/N) exp(−σ²). 단일 시나리오의 실현 손실이나 95% 보장 조건과는 다릅니다.';
}
function render(){
 selected=Math.min(selected,cfg.nodes-1);
 const m=metrics(cfg,cfg.timeS);summary(m);results(m);
 $('#title').textContent=info[tab][0];$('#subtitle').textContent=info[tab][1];$('#view-tag').textContent=info[tab][2];
 if(tab==='formation')formationView(m);else if(tab==='focus')focusView();else if(tab==='sync')syncView(m);else reqView();
}
function switchTab(next){stop();tab=next;$$('.tab').forEach(b=>{const active=b.dataset.tab===tab;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))});controls();render()}
function clearPreset(){$$('[data-preset]').forEach(b=>b.setAttribute('aria-pressed','false'))}
$$('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
$$('[data-preset]').forEach(b=>b.onclick=()=>{
 cfg={...DEFAULTS,...(b.dataset.preset==='error'?{pathErrorMm:3}:b.dataset.preset==='drift'?{freqOffsetHz:.35,timeS:.5}: {})};
 selected=0;clearPreset();b.setAttribute('aria-pressed','true');switchTab(b.dataset.preset==='ideal'?'formation':'sync');
});
$('#reset').onclick=()=>{cfg={...DEFAULTS};selected=0;clearPreset();$('#message').textContent='초기 설정으로 돌아왔습니다.';switchTab('formation')};
function download(name,content,type){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([content],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('#saveJson').onclick=()=>download('virtual-satellite-scenario.json',JSON.stringify({schema:'virtual-satellite-v0.1',...cfg},null,2),'application/json');
$('#saveCsv').onclick=()=>{
 const m=metrics(cfg,cfg.timeS),rows=[['metric','value','unit'],['nodes',cfg.nodes,'count'],['frequency',cfg.freqGHz,'GHz'],['baseline',cfg.baselineM,'m'],['path_error_rms',cfg.pathErrorMm,'mm'],['rf_phase_rms',cfg.rfPhaseRmsDeg,'deg'],['coherence',m.coherence,'ratio'],['coherence_loss',m.coherenceLossDb,'dB'],['gain_vs_incoherent',m.gainVsIncoherentDb,'dB'],['time',cfg.timeS,'s']];
 download('virtual-satellite-result.csv','\ufeff'+rows.map(r=>r.join(',')).join('\n'),'text/csv');
};
$('#loadJson').onchange=async e=>{
 stop();const file=e.target.files[0];if(!file)return;
 try{const o=JSON.parse(await file.text());if(!o||typeof o!=='object'||Array.isArray(o)||!Object.keys(DEFAULTS).some(k=>Object.hasOwn(o,k)))throw new Error('invalid');
 cfg=normalizeConfig(o);selected=0;clearPreset();controls();render();$('#message').textContent='시나리오를 불러왔습니다. 입력값은 지원 범위 안에서 적용됩니다.';
 }catch{$('#message').textContent='시나리오를 읽을 수 없습니다. 저장한 JSON 파일을 확인해 주세요.'}
 e.target.value='';
};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing){stop();render()}});
controls();render();
