import {
  metrics, focusMap, quantilePhaseRms, quantileCurve, requirement, precisionFromPhase, farFieldKm, wavelength,
  arrayScales, effectiveMapSpanKm, phaseBudget, monteCarlo,
} from './physics.js?v=0.3.0';
import {
  DEFAULTS, LIMITS, SCHEMA, normalizeConfig, migrateScenario, configToParams, configFromParams, phaseDegrees, expectedCoherence,
} from './state.js?v=0.3.0';

const TABS = ['formation', 'focus', 'sync', 'req'];
const MAP_SIZE = 121;
const PLAYBACK_END_S = 2;

let cfg = { ...DEFAULTS }, tab = 'formation', selected = 0;
let playing = false, frame = 0, previous = 0;

// ---------------------------------------------------------------- helpers

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const fmt = (x, d = 2) => (Number.isFinite(x) ? (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toFixed(d) : x === Infinity ? '∞' : x === -Infinity ? '−∞' : '—');
const fmtLength = m => {
  const a = Math.abs(m);
  if (a >= 1000) return `${fmt(m / 1000, a >= 10000 ? 1 : 2)} km`;
  return `${fmt(m, a >= 100 || a === 0 ? 0 : a >= 10 ? 1 : 2)} m`;
};
const setText = (id, value) => {
  const el = document.getElementById(id);
  if (el && el.textContent !== value) el.textContent = value;
};
const names = {
  Grid: '격자', Ring: '원형', Line: '선형', Random: '무작위',
  Estimated: '추정 위치로 보정', Oracle: '실제 위치로 보정', None: '보정 없음',
  'Total fixed': '전체 전력 고정', 'Per node': '위성당 전력 고정',
  Auto: '빔 폭에 맞춤', Manual: '직접 입력',
};

// Cyclic phase colours (0° mint → +90° blue → ±180° amber → −90° pink) so the sign stays visible.
const PHASE_STOPS = [[119, 228, 199], [131, 182, 255], [243, 188, 114], [232, 143, 200]];
const phaseColor = a => {
  const t = ((phaseDegrees(a) + 360) % 360) / 90, i = Math.floor(t) % 4, f = t - Math.floor(t);
  const from = PHASE_STOPS[i], to = PHASE_STOPS[(i + 1) % 4];
  return `rgb(${from.map((v, k) => Math.round(v + (to[k] - v) * f)).join(',')})`;
};
// Approximation of matplotlib's cividis: perceptually uniform and colour-vision-deficiency safe.
const MAP_STOPS = [[0, 32, 77], [65, 77, 107], [124, 123, 120], [188, 175, 111], [253, 231, 37]];
const mapColor = t => {
  const v = Math.max(0, Math.min(1, t)) * 4, i = Math.min(3, Math.floor(v)), f = v - i;
  return MAP_STOPS[i].map((a, k) => Math.round(a + (MAP_STOPS[i + 1][k] - a) * f));
};

const line = (x1, y1, x2, y2, color = '#283b4d', extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ${extra}/>`;
const text = (x, y, value, extra = '') => `<text x="${x}" y="${y}" ${extra}>${value}</text>`;
const circle = (x, y, r, color, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" ${extra}/>`;
const svg = (body, label, view = '0 0 640 440') => `<svg class="chart" viewBox="${view}" role="img" aria-label="${label}">${body}</svg>`;
const pathOf = points => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

// ---------------------------------------------------------------- background computation

// Heavy jobs run in a module worker. Only one request per job is in flight; newer requests replace
// the queued one, so dragging a slider never builds a backlog. Without a worker, jobs run inline.
const JOBS = { focusMap, quantilePhaseRms, quantileCurve };
const results = new Map(), inFlight = new Map(), queued = new Map();
let worker = null;
try {
  worker = new Worker(new URL('./worker.js?v=0.3.0', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const sent = inFlight.get(data.job);
    inFlight.delete(data.job);
    // A job that throws in the worker is retried inline so the view never waits forever.
    remember(data.key, data.error ? JOBS[data.job](...sent.args) : data.result);
    const next = queued.get(data.job);
    queued.delete(data.job);
    if (next && !results.has(next.key)) send(data.job, next.key, next.args);
    render();
  };
  worker.onerror = () => {
    worker = null;
    inFlight.clear();
    queued.clear();
    render();
  };
} catch {
  worker = null;
}
function remember(key, value) {
  results.set(key, value);
  if (results.size > 32) results.delete(results.keys().next().value);
}
function send(job, key, args) {
  inFlight.set(job, { key, args });
  worker.postMessage({ job, key, args });
}
/** Cached result, or undefined while the worker is still computing it. */
function compute(job, ...args) {
  const key = job + JSON.stringify(args);
  if (results.has(key)) return results.get(key);
  if (!worker) {
    remember(key, JOBS[job](...args));
    return results.get(key);
  }
  if (inFlight.get(job)?.key === key) return undefined;
  if (inFlight.has(job)) queued.set(job, { key, args });
  else send(job, key, args);
  return undefined;
}
let mcKey = '', mcValue = null;
function scenarioMonteCarlo() {
  const key = JSON.stringify(cfg);
  if (key !== mcKey) {
    mcValue = monteCarlo(cfg, cfg.timeS);
    mcKey = key;
  }
  return mcValue;
}
const quantileRequirement = (n, lossDb, f) => {
  const s = compute('quantilePhaseRms', n, lossDb);
  return s == null ? s : precisionFromPhase(s, f);
};

// ---------------------------------------------------------------- controls

const isNumberText = v => v.trim() !== '' && Number.isFinite(Number(v));
const mapSpanText = () => String(Number(effectiveMapSpanKm(cfg).toPrecision(4)));
const displayValue = key => (key === 'mapSpanKm' ? mapSpanText() : cfg[key]);

const field = (k, label, step, unit = '', slider = false) => `<div class="field"><label for="f-${k}">${label}<span>${unit}</span></label><input id="f-${k}" data-key="${k}" type="number" min="${LIMITS[k][0]}" max="${LIMITS[k][1]}" step="${step}" value="${displayValue(k)}">${slider ? `<input type="range" data-range="${k}" min="${LIMITS[k][0]}" max="${LIMITS[k][1]}" step="${step}" value="${cfg[k]}" aria-label="${label} 슬라이더">` : ''}</div>`;
const select = (k, label, options) => `<div class="field"><label for="f-${k}">${label}</label><select id="f-${k}" data-key="${k}">${options.map(v => `<option value="${v}">${names[v]}</option>`).join('')}</select></div>`;

function buildControls() {
  $('#controls').innerHTML = `
  <div class="group"><h3><b>01</b> CONSTELLATION</h3>${field('nodes', '위성 수', 1, '대', true)}${select('formation', '배치 형태', ['Grid', 'Ring', 'Line', 'Random'])}<div class="pair">${field('baselineM', '배열 크기 B', 1, 'm')}${field('rangeKm', '목표 거리', 1, 'km')}</div><p class="hint">B는 배치 생성 기준 길이입니다.<br>격자 배열의 대각선 길이는 B보다 큽니다.</p></div>
  <div class="group"><h3><b>02</b> RADIO FREQUENCY</h3>${field('freqGHz', '반송파 주파수', 0.1, 'GHz')}<div class="quick">${[2, 20, 30].map(f => `<button data-freq="${f}">${f} GHz</button>`).join('')}</div><div class="stack">${field('totalPowerW', '전체 RF 전력', 1, 'W')}${select('powerMode', '전력 기준', ['Total fixed', 'Per node'])}</div></div>
  <div class="group"><h3><b>03</b> PHASE & ERRORS</h3>${select('command', '위상 보정', ['Estimated', 'Oracle', 'None'])}<div class="pair">${field('pathErrorMm', '경로 오차 RMS', 0.1, 'mm')}${field('rfPhaseRmsDeg', 'RF 위상 RMS', 0.1, '°')}</div><div class="pair">${field('freqOffsetHz', '주파수 오차', 0.01, 'Hz RMS')}${field('timeS', '경과 시간', 0.001, 's')}</div><div class="pair">${field('velocityErrorMmS', '속도 추정 오차', 0.1, 'mm/s')}${field('phaseWalkDegRtS', '위상 확산', 1, '°/√s')}</div><p class="hint">속도 오차는 잔여 도플러 v/λ로, 위상 확산은 발진기 위상의 랜덤워크(D·√t)로 시간에 따라 쌓입니다.</p></div>
  <div class="group"><h3><b>04</b> OBSERVATION</h3>${field('lossTargetDb', '평균 손실 목표', 0.01, 'dB')}<div class="field"><label for="f-seed">난수 시드<span>seed</span></label><div class="inline"><input id="f-seed" data-key="seed" type="number" min="${LIMITS.seed[0]}" max="${LIMITS.seed[1]}" step="1" value="${cfg.seed}"><button id="reseed" class="small" aria-label="새 난수 시드">새 시드</button></div></div><div data-focus-only>${select('mapScale', '초점 지도 범위', ['Auto', 'Manual'])}${field('mapSpanKm', '초점 지도 폭', 'any', 'km')}</div><p class="hint">같은 시드는 같은 오차 실현값을 만듭니다. 경로 RMS는 3D 위치 오차와 다릅니다.</p></div>`;

  // While typing, apply valid values without rewriting the field (so "0.0" can become "0.005"); on change, show the normalized value or restore it.
  const apply = (el, write) => {
    stop();
    const key = el.dataset.key;
    if (el.tagName === 'INPUT' && !isNumberText(el.value)) {
      if (write) el.value = displayValue(key);
      return;
    }
    const patch = { [key]: el.tagName === 'SELECT' ? el.value : Number(el.value) };
    if (key === 'mapSpanKm') patch.mapScale = 'Manual';
    if (key === 'mapScale' && el.value === 'Manual' && cfg.mapScale === 'Auto') patch.mapSpanKm = effectiveMapSpanKm(cfg);
    cfg = normalizeConfig(patch, cfg);
    if (write) el.value = displayValue(key);
    syncControls(el);
    clearPreset();
    render();
  };
  $$('[data-key]').forEach(el => {
    el.onchange = () => apply(el, true);
    if (el.tagName === 'INPUT') el.oninput = () => {
      const value = Number(el.value), [min, max] = LIMITS[el.dataset.key];
      if (isNumberText(el.value) && value >= min && value <= max) apply(el, false);
    };
  });
  $$('[data-range]').forEach(el => el.oninput = () => {
    stop();
    cfg = normalizeConfig({ [el.dataset.range]: Number(el.value) }, cfg);
    syncControls(el);
    clearPreset();
    render();
  });
  $$('[data-freq]').forEach(b => b.onclick = () => {
    stop();
    cfg = normalizeConfig({ freqGHz: Number(b.dataset.freq) }, cfg);
    syncControls();
    clearPreset();
    render();
  });
  $('#reseed').onclick = () => {
    stop();
    cfg = normalizeConfig({ seed: Math.floor(Math.random() * 2 ** 32) }, cfg);
    syncControls();
    clearPreset();
    render();
  };
}

/** Write cfg into the existing controls in place, leaving `except` (the element being edited) alone. */
function syncControls(except = null) {
  $$('[data-key]').forEach(el => {
    if (el !== except) el.value = displayValue(el.dataset.key);
  });
  $$('[data-range]').forEach(el => {
    if (el !== except) el.value = cfg[el.dataset.range];
  });
  $$('[data-freq]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.freq) === cfg.freqGHz)));
  $('label[for="f-totalPowerW"]').firstChild.nodeValue = cfg.powerMode === 'Per node' ? '위성당 RF 전력' : '전체 RF 전력';
  $$('[data-focus-only]').forEach(el => el.hidden = tab !== 'focus');
}

// ---------------------------------------------------------------- summary and inspector

function buildSummary() {
  $('#summary').innerHTML = `<div class="metric primary"><div class="metric-label">신호가 모이는 정도 <em id="s-status"></em></div><div class="metric-value"><span id="s-coherence"></span><small>%</small></div><div class="meter" aria-hidden="true"><i id="s-meter"></i></div><p>이상적으로 정렬된 신호 전력 대비</p></div><div class="metric"><div class="metric-label">결맞음 손실</div><div class="metric-value"><span id="s-loss"></span><small>dB</small></div><p>낮을수록 좋음 · 목표 <span id="s-target"></span> dB</p></div><div class="metric"><div class="metric-label">비결맞음 대비 이득</div><div class="metric-value"><span id="s-gain"></span><small>dB</small></div><p>같은 위성 수 · 같은 총 전력 기준</p></div>`;
}
function updateSummary(m) {
  const coherence = Math.min(100, Math.max(0, m.coherence * 100)), ok = m.coherenceLossDb <= cfg.lossTargetDb;
  setText('s-status', ok ? '목표 손실 이내' : '목표 손실 초과');
  setText('s-coherence', fmt(coherence, 1));
  $('#s-meter').style.width = `${coherence}%`;
  setText('s-loss', fmt(m.coherenceLossDb));
  setText('s-target', String(cfg.lossTargetDb));
  setText('s-gain', `${m.gainVsIncoherentDb >= 0 ? '+' : ''}${fmt(m.gainVsIncoherentDb)}`);
}

// The inspector is built once and patched in place: re-creating it every playback frame would swallow
// clicks (mousedown and mouseup landing on different elements) and drop keyboard focus.
function buildResults() {
  const row = (label, id, title = '') => `<div><dt>${label}</dt><dd id="${id}"${title ? ` title="${title}"` : ''}></dd></div>`;
  $('#results').innerHTML = `<section class="inspector-card"><h3>READING THE SIGNAL</h3><h4 id="r-verdict" class="verdict"></h4><p id="r-explain"></p><div id="r-strip" class="phase-strip" aria-label="위성별 잔여 위상"></div><button id="r-goto" class="inspector-link"></button></section>
  <section class="inspector-card"><h3>SCENARIO SNAPSHOT</h3><dl>${row('편대', 'r-formation')}${row('배열 크기', 'r-baseline')}${row('목표 거리', 'r-range')}${row('파장', 'r-lambda')}${row('전체 RF 전력', 'r-power')}${row('원거리장 척도', 'r-farfield', '2B²/λ · 엄밀 경계가 아닌 척도')}${row('주빔 폭', 'r-beam', 'λR/B · 목표 평면에서의 대략적 폭')}${row('경과 시간', 'r-time')}</dl></section>
  <section class="inspector-card"><h3>PRECISION GUIDE</h3><p>평균 <span id="r-loss"></span> dB 손실에 해당하는<br>등가 단방향 경로 RMS</p><div class="big"><span id="r-path"></span> <small>mm</small></div><p id="r-phase"></p><p class="guarantee">95% 보장 경로 RMS <strong id="r-path95"></strong></p><button class="inspector-link" data-goto="req">요구 조건 살펴보기 ↗</button></section>`;
  $('#r-goto').onclick = e => switchTab(e.currentTarget.dataset.goto);
  $$('[data-goto]').forEach(b => b.onclick = () => switchTab(b.dataset.goto));
}
function updateResults(m) {
  const r = requirement(cfg.nodes, cfg.lossTargetDb, cfg.freqGHz), ok = m.coherenceLossDb <= cfg.lossTargetDb;
  const verdict = $('#r-verdict');
  setText('r-verdict', ok ? '신호가 잘 모이고 있어요' : '신호가 흩어지고 있어요');
  verdict.classList.toggle('caution', !ok);
  setText('r-explain', cfg.nodes === 1 ? '위성이 하나면 위상 상쇄가 없습니다. 여러 위성을 배치해 합성 효과를 비교하세요.' : ok ? '위성들의 신호가 목표점에서 잘 합쳐지고 있습니다. 경로 오차를 높여 신호가 흩어지는 모습을 비교해 보세요.' : '위성 간 위상 차이로 신호가 서로 상쇄됩니다. 경로·RF·주파수 오차와 보정 방식을 확인하세요.');
  const strip = $('#r-strip');
  if (strip.children.length !== m.phases.length) strip.innerHTML = m.phases.map(() => '<i></i>').join('');
  m.phases.forEach((a, i) => {
    const el = strip.children[i];
    el.style.background = phaseColor(a);
    el.title = `위성 ${i + 1}: ${fmt(phaseDegrees(a), 1)}°`;
  });
  const go = $('#r-goto'), target = tab === 'sync' ? 'focus' : 'sync';
  go.dataset.goto = target;
  setText('r-goto', target === 'focus' ? '초점 지도 확인 ↗' : '위상 벡터 확인 ↗');

  setText('r-formation', `${names[cfg.formation]} · ${cfg.nodes}대`);
  setText('r-baseline', `${cfg.baselineM} m`);
  setText('r-range', `${cfg.rangeKm} km`);
  setText('r-lambda', `${fmt(wavelength(cfg.freqGHz) * 1000, 3)} mm`);
  setText('r-power', `${fmt(cfg.totalPowerW * (cfg.powerMode === 'Per node' ? cfg.nodes : 1), 1)} W`);
  setText('r-farfield', `${fmt(farFieldKm(cfg.baselineM, cfg.freqGHz), 0)} km`);
  setText('r-beam', fmtLength(arrayScales(cfg).beamM));
  setText('r-time', `${fmt(cfg.timeS, 3)} s`);

  setText('r-loss', String(cfg.lossTargetDb));
  setText('r-path', r ? fmt(r.pathRmsMm, 3) : '—');
  setText('r-phase', r ? `위상 RMS ${fmt(r.phaseRmsDeg, 2)}° · 고주파일수록 더 정밀한 보정이 필요합니다.` : '현재 조건에는 유한한 RMS 경계가 없습니다.');
  const q = quantileRequirement(cfg.nodes, cfg.lossTargetDb, cfg.freqGHz);
  setText('r-path95', q === undefined ? '계산 중…' : q ? `${fmt(q.pathRmsMm, 3)} mm` : '경계 없음');
}

// ---------------------------------------------------------------- views

const info = {
  formation: ['편대의 모양과 신호 상태', '위성을 선택해 위치와 목표점에서의 잔여 위상을 확인하세요.', 'TOP VIEW'],
  focus: ['신호가 모이는 곳', '밝을수록 강한 신호입니다. 십자선은 목표점, 점선 원은 예측한 격자 로브입니다.', 'FOCUS MAP'],
  sync: ['같은 방향일수록, 강한 신호', '얇은 선은 위성별 위상, 굵은 화살표는 평균 합성 벡터입니다.', 'PHASE VIEW'],
  req: ['얼마나 정확하게 맞춰야 할까?', '손실 목표를 평균 기준과 95% 보장 기준의 경로·위상 정밀도로 바꿉니다.', 'REQUIREMENT'],
};
const phaseLegend = '<span class="phase-scale"><span>−180°</span><i aria-hidden="true"></i><span>+180°</span></span>';

function formationView(m) {
  const cx = 320, cy = 207, scale = 300 / cfg.baselineM;
  let h = '';
  for (let i = -2; i <= 2; i++) {
    const p = i * 75;
    h += line(135, cy + p, 505, cy + p, '#22303e') + line(cx + p, 35, cx + p, 380, '#22303e');
    h += text(122, cy + p + 4, fmt(-i * cfg.baselineM / 4, 0), 'text-anchor="end"') + text(cx + p, 401, fmt(i * cfg.baselineM / 4, 0), 'text-anchor="middle"');
  }
  h += line(cx, 32, cx, 381, '#486171', 'stroke-dasharray="3 5"') + line(133, cy, 507, cy, '#486171', 'stroke-dasharray="3 5"');
  h += text(512, 224, 'x / m', 'class="axis-title"') + text(330, 28, 'y / m', 'class="axis-title"');
  if (cfg.formation === 'Ring') h += circle(cx, cy, 150, 'none', 'stroke="#365a5c" stroke-dasharray="4 7"');
  h += circle(cx, cy, 7, 'none', 'stroke="#e6eeda"') + line(cx - 12, cy, cx + 12, cy, '#e6eeda') + line(cx, cy - 12, cx, cy + 12, '#e6eeda');
  m.truth.forEach((p, i) => {
    const x = cx + p[0] * scale, y = cy - p[1] * scale, color = phaseColor(m.phases[i]), r = cfg.nodes > 36 ? 11 : 15, deg = fmt(phaseDegrees(m.phases[i]), 1);
    const body = `<rect x="${x - 14}" y="${y - 5}" width="8" height="10" rx="1" fill="${color}" opacity=".6"/><rect x="${x + 6}" y="${y - 5}" width="8" height="10" rx="1" fill="${color}" opacity=".6"/><rect x="${x - 4}" y="${y - 5}" width="8" height="10" rx="2" fill="${color}"/>`;
    h += `<g class="node" data-node="${i}" tabindex="0" role="button" aria-label="위성 ${i + 1}, 잔여 위상 ${deg}도" aria-pressed="${selected === i}"><title>위성 ${i + 1} · ${deg}°</title>${circle(x, y, r + 6, 'transparent', `class="node-ring" stroke="${selected === i ? '#d7fff4' : 'transparent'}"`)}${line(x - 13, y, x + 13, y, color, 'stroke-width="2"')}${body}${text(x, y + 29, String(i + 1).padStart(2, '0'), 'text-anchor="middle" class="node-label"')}</g>`;
  });
  $('#visual').innerHTML = svg(h, '위성 편대의 평면 배치와 위성별 위상. 각 위성을 선택할 수 있습니다.') + `<div class="legend-row">${phaseLegend}<span>색: 목표점에서의 잔여 위상 (0° 민트 · +90° 파랑 · −90° 분홍)</span><span>⊕ 목표점의 평면 투영</span></div><div id="node-info" class="node-info"></div>`;
  updateNodeInfo(m);
  $$('[data-node]').forEach(el => {
    const pick = () => selectNode(Number(el.dataset.node), m);
    el.onclick = pick;
    el.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    };
  });
  $('#view-note').innerHTML = '<b>읽는 법</b> 아이콘은 실제 크기가 아닙니다. 색은 목표점에서의 잔여 위상이며 +와 − 방향을 구분합니다. 경로 추정 오차는 깊이(z) 방향에 적용되어 평면 위치에는 나타나지 않습니다.';
}
function selectNode(i, m) {
  selected = i;
  updateNodeInfo(m);
  $$('[data-node]').forEach(n => {
    const active = Number(n.dataset.node) === selected;
    n.setAttribute('aria-pressed', String(active));
    n.querySelector('.node-ring').setAttribute('stroke', active ? '#d7fff4' : 'transparent');
  });
}
function updateNodeInfo(m) {
  const p = m.truth[selected], e = m.estimate[selected];
  $('#node-info').innerHTML = `<strong>위성 ${String(selected + 1).padStart(2, '0')}</strong><span>x ${fmt(p[0], 1)} / y ${fmt(p[1], 1)} m</span><span>경로방향 Δz ${fmt((e[2] - p[2]) * 1000, 3)} mm</span><span>잔여 위상 ${fmt(phaseDegrees(m.phases[selected]), 1)}°</span>`;
}

let lastFocus = null;
function focusView() {
  const { lossTargetDb, mapScale, ...mapCfg } = cfg, span = effectiveMapSpanKm(cfg);
  const spanInput = $('#f-mapSpanKm');
  if (cfg.mapScale === 'Auto' && document.activeElement !== spanInput) spanInput.value = mapSpanText();
  const fresh = compute('focusMap', { ...mapCfg, mapSpanKm: span }, MAP_SIZE, cfg.timeS);
  if (fresh) lastFocus = fresh;
  const fm = fresh ?? lastFocus, scales = arrayScales(cfg);
  if (!fm) {
    $('#visual').innerHTML = '<p class="loading">초점 지도를 계산하고 있습니다…</p>';
    $('#view-note').innerHTML = '';
    return;
  }
  const off = document.createElement('canvas');
  off.width = off.height = fm.size;
  const ctx = off.getContext('2d'), img = ctx.createImageData(fm.size, fm.size);
  const db = v => Math.max(-35, 10 * Math.log10(Math.max(v / fm.max, 1e-12)));
  fm.values.forEach((v, i) => {
    const [r, g, b] = mapColor((db(v) + 35) / 35), o = ((fm.size - 1 - Math.floor(i / fm.size)) * fm.size + i % fm.size) * 4;
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = 255;
  });
  ctx.putImageData(img, 0, 0);

  // Map area: x 130–510, y 20–400 (380 px for 2·half metres).
  const half = fm.half, px = x => 320 + x / half * 190, py = y => 210 - y / half * 190;
  let h = `<image href="${off.toDataURL()}" x="130" y="20" width="380" height="380" style="image-rendering:pixelated"/>`;
  for (let i = 0; i <= 4; i++) {
    const p = 130 + i * 95, q = 20 + i * 95;
    h += text(p, 423, fmtLength((i / 4 - 0.5) * 2 * half), 'text-anchor="middle"') + text(117, q + 4, fmtLength((0.5 - i / 4) * 2 * half), 'text-anchor="end"');
  }
  h += line(130, 210, 510, 210, '#d7eee3', 'stroke-dasharray="4 5" opacity=".6"') + line(320, 20, 320, 400, '#d7eee3', 'stroke-dasharray="4 5" opacity=".6"');
  const lobes = [];
  const gx = scales.gratingXM, gy = scales.gratingYM;
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      if ((!i && !j) || (i && !gx) || (j && !gy)) continue;
      const x = i * (gx ?? 0), y = j * (gy ?? 0);
      if (Math.abs(x) < half * 0.97 && Math.abs(y) < half * 0.97) lobes.push([x, y]);
    }
  }
  if (lobes.length <= 40) lobes.forEach(([x, y]) => h += circle(px(x), py(y), 8, 'none', 'stroke="#fff" stroke-dasharray="2 3" opacity=".65"'));
  h += circle(320, 210, 9, 'none', 'stroke="#fff" stroke-width="1.5"') + text(334, 199, '목표점', 'style="fill:#fff"') + text(550, 438, 'x') + text(131, 12, 'y');

  const step = 2 * half / (fm.size - 1), undersampled = step > scales.beamM / 3, mid = (fm.size - 1) >> 1;
  const curve = [];
  for (let i = 0; i < fm.size; i++) curve.push([65 + i / (fm.size - 1) * 530, 36 - db(fm.values[mid * fm.size + i]) / 35 * 91]);
  let cut = '';
  [0, -10, -20, -30].forEach(v => {
    const y = 36 - v / 35 * 91;
    cut += line(65, y, 595, y, '#263644') + text(53, y + 4, v, 'text-anchor="end"');
  });
  cut += `<path d="${pathOf(curve)}" fill="none" stroke="#e8d36a" stroke-width="1.8"/>` + line(330, 30, 330, 133, '#9caebc', 'stroke-dasharray="3 4"') + text(65, 155, fmtLength(-half)) + text(595, 155, fmtLength(half), 'text-anchor="end"') + text(330, 155, '목표점', 'text-anchor="middle"');

  const auto = cfg.mapScale === 'Auto';
  $('#visual').innerHTML = svg(h, '목표점 주변 신호 전력 지도, 지도 최댓값 기준 데시벨') + `<div class="color-scale"><span>−35 dB</span><i></i><span>0 dB</span></div><div class="section-caption"><span>가로 단면 · y = 0${fresh ? '' : ' · 갱신 중…'}</span><button id="zoomFocus" class="text-button">${auto ? '넓게 보기 (10 km) ↗' : '빔 폭에 맞춤 ↺'}</button></div>` + svg(cut, '초점 지도의 중앙 가로 단면', '0 0 640 175');
  $('#zoomFocus').onclick = () => {
    stop();
    cfg = normalizeConfig(auto ? { mapScale: 'Manual', mapSpanKm: 10 } : { mapScale: 'Auto' }, cfg);
    syncControls();
    clearPreset();
    render();
  };
  const lobeText = scales.gratingM ? `가장 가까운 격자 로브 ${fmtLength(scales.gratingM)}` : '주기 배치가 아니어서 격자 로브 대신 불규칙한 부엽이 생깁니다';
  $('#view-note').innerHTML = `<b>${undersampled ? '표본 부족 · 무늬가 실제 빔이 아닐 수 있습니다' : '주빔과 격자 로브를 표본화한 보기'}</b> 주빔 폭 ≈ λR/B = ${fmtLength(scales.beamM)}, ${lobeText}, 표본 간격 ${fmtLength(step)}. 색과 단면은 지도 최댓값을 0 dB로 정규화합니다. 실제 목표점 결맞음은 상단 수치를 확인하세요.`;
}

function arrow(x1, y1, x2, y2, color, width = 2) {
  const a = Math.atan2(y2 - y1, x2 - x1), r = 9;
  if (Math.hypot(x2 - x1, y2 - y1) < 1) return circle(x1, y1, 3, color);
  return line(x1, y1, x2, y2, color, `stroke-width="${width}" stroke-linecap="round"`) + `<path d="M${x2 - r * Math.cos(a - 0.5)},${y2 - r * Math.sin(a - 0.5)} L${x2},${y2} L${x2 - r * Math.cos(a + 0.5)},${y2 - r * Math.sin(a + 0.5)}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
}
function syncView(m) {
  const cx = 320, cy = 198, r = 144;
  let h = '';
  [0.5, 1].forEach(k => h += circle(cx, cy, r * k, 'none', 'stroke="#2b3e4e" stroke-dasharray="3 5"'));
  h += line(cx - r - 22, cy, cx + r + 22, cy) + line(cx, cy - r - 20, cx, cy + r + 20);
  h += text(cx + r + 25, cy + 4, '0°') + text(cx, cy - r - 24, '90°', 'text-anchor="middle"') + text(cx - r - 26, cy + 4, '±180°', 'text-anchor="end"') + text(cx, cy + r + 28, '−90°', 'text-anchor="middle"');
  let re = 0, im = 0;
  m.phases.forEach(a => {
    re += Math.cos(a) / cfg.nodes;
    im += Math.sin(a) / cfg.nodes;
    const ex = cx + r * Math.cos(a), ey = cy - r * Math.sin(a);
    h += line(cx, cy, ex, ey, phaseColor(a), 'stroke-width="1.4" opacity=".55"') + circle(ex, ey, 3, phaseColor(a));
  });
  h += arrow(cx, cy, cx + r * re, cy - r * im, '#eefcf8', 4) + circle(cx, cy, 4, '#eefcf8');
  h += text(cx, 399, `평균 벡터 길이 ${fmt(Math.sqrt(m.coherence), 3)} → 신호 전력 ${fmt(m.coherence * 100, 1)}%`, 'text-anchor="middle" class="svg-value"');
  const plot = svg(h, '위성별 잔여 위상과 평균 합성 벡터');
  const playLabel = playing ? 'Ⅱ 일시정지' : '▷ 재생';
  if ($('#phase-plot')) {
    $('#phase-plot').innerHTML = plot;
    setText('play', playLabel);
    $('#play').setAttribute('aria-pressed', String(playing));
    $('#timeline').value = Math.min(PLAYBACK_END_S, cfg.timeS);
    $('.playback output').value = `${fmt(cfg.timeS, 3)} s`;
  } else {
    $('#visual').innerHTML = `<div id="phase-plot">${plot}</div><div class="legend-row">${phaseLegend}<span>↗ 흰색: 평균 합성 벡터</span><span>벡터 길이² = 결맞음 계수</span></div><div class="playback"><button id="play" aria-pressed="${playing}">${playLabel}</button><input id="timeline" aria-label="시간 탐색" type="range" min="0" max="${PLAYBACK_END_S}" step=".001" value="${Math.min(PLAYBACK_END_S, cfg.timeS)}"><output>${fmt(cfg.timeS, 3)} s</output></div>`;
  }
  $('#play').onclick = () => {
    if (playing) {
      stop();
      render();
      return;
    }
    if (cfg.timeS >= PLAYBACK_END_S) cfg.timeS = 0;
    playing = true;
    previous = 0;
    render();
    frame = requestAnimationFrame(tick);
  };
  $('#timeline').oninput = e => {
    stop();
    cfg.timeS = Number(e.target.value);
    syncControls();
    clearPreset();
    render();
  };
  $('#view-note').innerHTML = '<b>시간 탐색 · 0–2초</b> 주파수 오차·속도 오차·위상 확산이 있으면 시간이 흐르며 화살표가 벌어집니다. 모두 0이면 정지해 보이는 것이 정상입니다. 높은 주파수 오차는 화면 갱신 사이 변화를 모두 보여주지 못합니다.';
}
function tick(now) {
  if (!playing) return;
  if (!previous) previous = now;
  if (now - previous >= 80) {
    cfg.timeS = Math.min(PLAYBACK_END_S, cfg.timeS + (now - previous) / 1000);
    previous = now;
    if (cfg.timeS >= PLAYBACK_END_S) playing = false;
    $('#f-timeS').value = fmt(cfg.timeS, 3);
    render();
  }
  if (playing) frame = requestAnimationFrame(tick);
}
function stop() {
  playing = false;
  cancelAnimationFrame(frame);
}

function reqView() {
  const n = cfg.nodes, r = requirement(n, cfg.lossTargetDb, cfg.freqGHz), target = 10 ** (-cfg.lossTargetDb / 10);
  const sq = compute('quantilePhaseRms', n, cfg.lossTargetDb), q = sq == null ? sq : precisionFromPhase(sq, cfg.freqGHz);
  const curve95 = n > 1 ? compute('quantileCurve', n) : null;
  const budget = phaseBudget(cfg, cfg.timeS), mc = scenarioMonteCarlo();
  const X = deg => 65 + Math.min(180, deg) / 180 * 529, Y = c => 215 - c * 180;
  let h = '';
  for (let i = 0; i <= 4; i++) {
    const y = 35 + i * 45;
    h += line(65, y, 594, y) + text(53, y + 4, `${100 - i * 25}%`, 'text-anchor="end"');
  }
  for (let i = 0; i <= 6; i++) h += text(65 + i / 6 * 529, 240, `${i * 30}°`, 'text-anchor="middle"');
  const mean = [];
  for (let i = 0; i <= 180; i++) mean.push([X(i), Y(expectedCoherence(n, i))]);
  h += `<path d="${pathOf(mean)}" fill="none" stroke="#77e4c7" stroke-width="2.5"/>`;
  if (curve95) h += `<path d="${pathOf(curve95.map((c, i) => [X(i * 3), Y(c)]))}" fill="none" stroke="#77e4c7" stroke-width="1.6" stroke-dasharray="5 4" opacity=".75"/>`;
  const y = Y(target);
  h += line(65, y, 594, y, '#f3bc72', 'stroke-dasharray="5 5"') + text(586, y + 15, `목표 ${fmt(target * 100, 1)}%`, 'text-anchor="end" style="fill:#f3bc72"');
  if (r && r.phaseRmsDeg <= 180) {
    const x = X(r.phaseRmsDeg);
    h += line(x, 35, x, 215, '#83b6ff', 'stroke-dasharray="4 5"') + circle(x, y, 5, '#83b6ff') + text(Math.min(x + 8, 480), 30, `평균 ${fmt(r.phaseRmsDeg, 1)}°`, 'style="fill:#83b6ff"');
  }
  if (q && q.phaseRmsDeg <= 180) {
    const x = X(q.phaseRmsDeg);
    h += line(x, 35, x, 215, '#b9a6ff', 'stroke-dasharray="2 4"') + circle(x, y, 4, '#b9a6ff') + text(Math.max(70, x - 8), 48, `95% ${fmt(q.phaseRmsDeg, 1)}°`, 'text-anchor="end" style="fill:#b9a6ff"');
  }
  if (budget) {
    const x = X(budget.total), cy = Y(expectedCoherence(n, budget.total));
    h += circle(x, cy, 6, '#fff', 'stroke="#0e1722" stroke-width="2"');
  }
  h += text(65, 18, '결맞음 계수') + text(594, 263, '위성별 위상 오차 RMS', 'text-anchor="end"');

  const freqs = [...new Set([2, 20, 30, cfg.freqGHz])].sort((a, b) => a - b);
  const pending = '계산 중…';
  const q95Cell = f => (sq === undefined ? pending : sq === null ? '경계 없음' : `${fmt(precisionFromPhase(sq, f).pathRmsMm, 3)} mm`);
  const table = `<table class="compare-table"><thead><tr><th>반송파</th><th>파장</th><th>평균 기준 경로 RMS</th><th>95% 보장 경로 RMS</th></tr></thead><tbody>${freqs.map(f => {
    const m = requirement(n, cfg.lossTargetDb, f);
    return `<tr class="${f === cfg.freqGHz ? 'current' : ''}"><td>${f} GHz ${f === cfg.freqGHz ? '· 현재' : ''}</td><td>${fmt(wavelength(f) * 1000, 2)} mm</td><td>${m ? `${fmt(m.pathRmsMm, 3)} mm` : '경계 없음'}</td><td>${q95Cell(f)}</td></tr>`;
  }).join('')}</tbody></table>`;
  const budgetRows = budget ? [['경로 추정', budget.path], ['RF 위상', budget.rf], ['주파수 오차 · 2πσ_f t', budget.drift], ['속도 오차 · kσ_v t', budget.doppler], ['위상 확산 · D√t', budget.walk]] : [];
  const budgetTable = budget
    ? `<table class="compare-table budget"><thead><tr><th>현재 위상 오차 예산 (t = ${fmt(cfg.timeS, 3)} s)</th><th>RMS</th></tr></thead><tbody>${budgetRows.map(([label, v]) => `<tr><td>${label}</td><td>${fmt(v, 2)}°</td></tr>`).join('')}<tr class="current"><td>합계 (제곱합 제곱근) → 예측 평균 손실</td><td>${fmt(budget.total, 2)}° → ${fmt(-10 * Math.log10(expectedCoherence(n, budget.total)), 2)} dB</td></tr></tbody></table>`
    : '<p class="req-note">보정 없음 모드에서는 잔여 위상이 기하학적 경로차이므로 무작위 오차 예산을 정의하지 않습니다.</p>';
  const mcText = `몬테카를로 ${mc.trials}회 (오차 실현값만 바꿈): 평균 손실 <strong>${fmt(mc.meanLossDb, 2)} dB</strong> · 95% 확률로 <strong>${fmt(mc.p05LossDb, 2)} dB</strong> 이내`;

  $('#visual').innerHTML = `<div class="req-intro">${r ? `평균 기준 경로 RMS <strong>${fmt(r.pathRmsMm, 3)}</strong> mm · 95% 보장 <strong class="q95">${q === undefined ? pending : q === null ? '—' : fmt(q.pathRmsMm, 3)}</strong> mm<br><span class="hint">평균 기준 위상 ${fmt(r.phaseRmsDeg, 2)}° · 등가 시간 ${fmt(r.timeRmsPs, 3)} ps</span>` : '현재 조건에서는 유한한 RMS 경계가 정의되지 않습니다.'}</div>`
    + svg(h, '위상 오차 RMS에 따른 평균 및 하위 5% 결맞음 계수와 목표 손실', '0 0 640 280')
    + `<div class="legend-row"><span><i class="legend-key"></i>평균 E[C]</span><span><i class="legend-key dashed"></i>하위 5% (95% 보장)</span>${budget ? `<span><i class="legend-key white"></i>현재 시나리오 ${fmt(budget.total, 1)}°${budget.total > 180 ? ' (범위 밖)' : ''}</span>` : ''}</div>`
    + `<p class="req-note">${mcText}</p>` + budgetTable + table;
  $('#view-note').innerHTML = '<b>모델 가정</b> 독립적인 0 평균 가우시안 위상 오차, 같은 채널 진폭. E[C] = 1/N + (1 − 1/N) exp(−σ²). 95% 보장 곡선과 경계는 같은 가정의 몬테카를로(1,000회)로 구하며, 경로 오차는 시선 방향 성분입니다.';
}

// ---------------------------------------------------------------- shell

function render() {
  selected = Math.min(selected, cfg.nodes - 1);
  const m = metrics(cfg, cfg.timeS);
  updateSummary(m);
  updateResults(m);
  setText('title', info[tab][0]);
  setText('subtitle', info[tab][1]);
  setText('view-tag', info[tab][2]);
  if (tab === 'formation') formationView(m);
  else if (tab === 'focus') focusView();
  else if (tab === 'sync') syncView(m);
  else reqView();
  scheduleHash();
}

function switchTab(next, focusTab = false) {
  stop();
  tab = next;
  $$('[role=tab]').forEach(b => {
    const active = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(active));
    b.tabIndex = active ? 0 : -1;
    if (active && focusTab) b.focus();
  });
  $('#view-panel').setAttribute('aria-labelledby', `tab-${tab}`);
  syncControls();
  render();
}
function clearPreset() {
  $$('[data-preset]').forEach(b => b.setAttribute('aria-pressed', 'false'));
}

// Shareable state: non-default settings live in the URL hash. Writes are debounced and skipped during
// playback (browsers throttle frequent history updates).
let hashTimer = 0;
function scheduleHash() {
  if (playing) return;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 250);
}
function writeHash() {
  const params = configToParams(cfg);
  if (tab !== 'formation') params.set('tab', tab);
  const hash = params.toString();
  if (location.hash.slice(1) !== hash) history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  cfg = configFromParams(params);
  const t = params.get('tab');
  tab = TABS.includes(t) ? t : 'formation';
}

$$('[role=tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$('[role=tablist]').onkeydown = e => {
  const i = TABS.indexOf(tab);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  switchTab(TABS[(next + TABS.length) % TABS.length], true);
};
$$('[data-preset]').forEach(b => b.onclick = () => {
  const preset = b.dataset.preset;
  cfg = { ...DEFAULTS, ...(preset === 'error' ? { pathErrorMm: 3 } : preset === 'drift' ? { freqOffsetHz: 0.35, timeS: 0.5 } : {}) };
  selected = 0;
  clearPreset();
  b.setAttribute('aria-pressed', 'true');
  switchTab(preset === 'ideal' ? 'formation' : 'sync');
});
$('#reset').onclick = () => {
  cfg = { ...DEFAULTS };
  selected = 0;
  clearPreset();
  $('#message').textContent = '초기 설정으로 돌아왔습니다.';
  switchTab('formation');
};

function download(name, content, type) {
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([content], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const UNITS = {
  nodes: 'count', baselineM: 'm', rangeKm: 'km', freqGHz: 'GHz', totalPowerW: 'W', pathErrorMm: 'mm', rfPhaseRmsDeg: 'deg',
  freqOffsetHz: 'Hz', velocityErrorMmS: 'mm/s', phaseWalkDegRtS: 'deg/sqrt(s)', mapSpanKm: 'km', lossTargetDb: 'dB', timeS: 's',
};
$('#copyLink').onclick = async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    $('#message').textContent = '현재 설정이 담긴 링크를 복사했습니다.';
  } catch {
    $('#message').textContent = `링크를 복사하지 못했습니다. 주소창의 URL을 사용하세요: ${location.href}`;
  }
};
$('#saveJson').onclick = () => download('virtual-satellite-scenario.json', JSON.stringify({ schema: SCHEMA, ...cfg }, null, 2), 'application/json');
$('#saveCsv').onclick = () => {
  const m = metrics(cfg, cfg.timeS), mc = scenarioMonteCarlo(), scales = arrayScales(cfg);
  const rows = [['name', 'value', 'unit'], ['schema', SCHEMA, '']];
  for (const key of Object.keys(DEFAULTS)) rows.push([key, cfg[key], UNITS[key] ?? '']);
  rows.push(
    ['effective_map_span', effectiveMapSpanKm(cfg), 'km'],
    ['wavelength', wavelength(cfg.freqGHz) * 1000, 'mm'],
    ['beam_width', scales.beamM, 'm'],
    ['nearest_grating_lobe', scales.gratingM ?? '', 'm'],
    ['coherence', m.coherence, 'ratio'],
    ['coherence_loss', m.coherenceLossDb, 'dB'],
    ['gain_vs_incoherent', m.gainVsIncoherentDb, 'dB'],
    ['mc_trials', mc.trials, 'count'],
    ['mc_mean_loss', mc.meanLossDb, 'dB'],
    ['mc_95pct_loss', mc.p05LossDb, 'dB'],
  );
  download('virtual-satellite-result.csv', `﻿${rows.map(r => r.join(',')).join('\n')}`, 'text/csv');
};
$('#loadJson').onchange = async e => {
  stop();
  const file = e.target.files[0];
  if (!file) return;
  try {
    const o = JSON.parse(await file.text());
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.keys(DEFAULTS).some(k => Object.hasOwn(o, k))) throw new Error('invalid');
    cfg = normalizeConfig(migrateScenario(o));
    selected = 0;
    clearPreset();
    switchTab(tab);
    $('#message').textContent = '시나리오를 불러왔습니다. 입력값은 지원 범위 안에서 적용됩니다.';
  } catch {
    $('#message').textContent = '시나리오를 읽을 수 없습니다. 저장한 JSON 파일을 확인해 주세요.';
  }
  e.target.value = '';
};
window.addEventListener('hashchange', () => {
  stop();
  readHash();
  selected = 0;
  clearPreset();
  switchTab(tab);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && playing) {
    stop();
    render();
  }
});

readHash();
buildControls();
buildSummary();
buildResults();
switchTab(tab);
