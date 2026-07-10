/* The Cutline — app logic (full rebuild).
   Every render guards against missing data: nothing prints "undefined". */
'use strict';

// ---------- constants ----------

const STAGES = ['design', 'print', 'laminate', 'cut', 'install', 'complete'];
const STAGE_LABEL = {
  design: 'Design', print: 'Print', laminate: 'Laminate',
  cut: 'Cut', install: 'Install', complete: 'Complete',
};
const STAGE_VAR = {
  design: 'st-design', print: 'st-print', laminate: 'st-laminate',
  cut: 'st-cut', install: 'st-install', complete: 'st-complete',
};
const SUBSTRATE_LABEL = {
  acm: 'ACM', coroplast: 'Coroplast', aluminum: 'Aluminum', pvc: 'PVC',
  acrylic: 'Acrylic', banner: 'Banner', vinyl: 'Vinyl', magnetic: 'Magnetic',
  mdo: 'MDO', other: 'Other',
};
const STALE_DAYS = 5;

const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
const SNOW_CODES = [71, 73, 75, 77, 85, 86];
const STORM_CODES = [95, 96, 99];

// ---------- state ----------

const state = {
  jobs: [],
  tasks: [],
  equipment: [],
  materials: [],
  quotes: [],
  notes: [],
  forecast: {},          // date -> {code, hi, lo, precip, wind, inclement, reason}
  hourly: [],            // [{label, code, temp, precip}]
  current: null,         // {temp, feels, humidity, wind, code}
  settings: null,
  page: 'dashboard',
  activeStage: 'all',
  activeSubstrate: 'all',
  batchMode: false,
  search: '',
  view: localStorage.getItem('cutline-view') || 'list',
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  modalJobId: null,
  quoteDraft: null,
};

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function txt(v, fallback = '') {
  return (v === null || v === undefined) ? fallback : String(v);
}

function money(n) {
  return '$' + num(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function woNum(id) { return 'WO-' + String(num(id)).padStart(4, '0'); }
function qNum(id) { return 'Q-' + String(num(id)).padStart(4, '0'); }

function initials(name) {
  const parts = txt(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function weatherIcon(code) {
  const c = num(code, -1);
  if (c === 0) return '☀️';
  if (c === 1 || c === 2) return '⛅';
  if (c === 3) return '☁️';
  if (c === 45 || c === 48) return '🌫️';
  if (STORM_CODES.includes(c)) return '⛈️';
  if (SNOW_CODES.includes(c)) return '❄️';
  if (RAIN_CODES.includes(c)) return '🌧️';
  return '☁️';
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

// ---------- router ----------

const PAGE_TITLES = {
  dashboard: 'Dashboard', jobs: 'Jobs', quotes: 'Quotes',
  materials: 'Materials', equipment: 'Equipment',
};

function route() {
  let hash = (location.hash || '#dashboard').slice(1);
  if (hash === 'calendar') {
    hash = 'jobs';
    state.view = 'calendar';
    localStorage.setItem('cutline-view', 'calendar');
  }
  if (!PAGE_TITLES[hash]) hash = 'dashboard';
  state.page = hash;

  document.querySelectorAll('.page').forEach(p => { p.hidden = true; });
  const section = $('page-' + hash);
  if (section) section.hidden = false;

  // Highlight the current page; the Calendar nav item lights up when the
  // calendar view is active on the jobs page.
  document.querySelectorAll('.nav-item').forEach(a => {
    if (a.dataset.page === 'calendar') {
      a.classList.toggle('active', hash === 'jobs' && state.view === 'calendar');
    } else if (a.dataset.page === 'jobs') {
      a.classList.toggle('active', hash === 'jobs' && state.view !== 'calendar');
    } else {
      a.classList.toggle('active', a.dataset.page === hash);
    }
  });

  $('page-title').textContent = PAGE_TITLES[hash];
  if (hash === 'jobs') renderJobs();
  if (hash === 'dashboard') renderDashboard();
}

window.addEventListener('hashchange', route);

// ---------- dashboard ----------

function renderDashboard() {
  renderKpis();
  renderPipeline();
  renderToday();
}

function renderKpis() {
  const today = isoToday();
  const open = state.jobs.filter(j => j.stage !== 'complete');
  const overdue = open.filter(j => j.due_date && j.due_date < today).length;
  const onHold = open.filter(j => j.on_hold).length;

  const weekOut = new Date();
  weekOut.setDate(weekOut.getDate() + 7);
  const weekStr = weekOut.toISOString().slice(0, 10);
  const installs = open.filter(j => j.install_date && j.install_date >= today && j.install_date <= weekStr).length;

  const openQuotes = state.quotes.filter(q => q.status === 'draft' || q.status === 'sent');
  const pipelineValue = openQuotes.reduce((sum, q) => sum + quoteTotals(parseQuoteItems(q), q.tax_rate).total, 0);

  const lowStock = state.materials.filter(materialLow).length;
  const equipDue = state.equipment.filter(equipmentDueSoon).length;

  const finished = state.jobs.filter(j => j.completed_at && j.created_at);
  let turnaround = '—';
  if (finished.length) {
    const avg = finished.reduce((s, j) => s + (new Date(j.completed_at) - new Date(j.created_at)), 0) / finished.length;
    turnaround = Math.max(0, Math.round(avg / 86400000)) + 'd';
  }

  const kpis = [
    { icon: '🗂️', bg: 'var(--primary-soft)', num: open.length, label: 'Open jobs' },
    { icon: '⏰', bg: 'var(--danger-soft)', num: overdue, label: 'Overdue', alert: overdue > 0 },
    { icon: '📌', bg: 'var(--warning-soft)', num: onHold, label: 'On hold' },
    { icon: '🚚', bg: 'var(--pink-soft)', num: installs, label: 'Installs this week' },
    { icon: '💵', bg: 'var(--success-soft)', num: money(pipelineValue), label: `Quote pipeline (${openQuotes.length})` },
    { icon: '⏱️', bg: 'var(--info-soft)', num: turnaround, label: 'Avg turnaround' },
    { icon: '📦', bg: 'var(--warning-soft)', num: lowStock, label: 'Low stock', alert: lowStock > 0 },
    { icon: '🔧', bg: 'var(--purple-soft)', num: equipDue, label: 'Equipment due', alert: equipDue > 0 },
  ];

  $('kpi-grid').innerHTML = kpis.map(k => `
    <div class="kpi${k.alert ? ' alert' : ''}">
      <div class="kpi-icon" style="background:${k.bg}">${k.icon}</div>
      <div><div class="kpi-num">${k.num}</div><div class="kpi-label">${k.label}</div></div>
    </div>
  `).join('');
}

function renderPipeline() {
  const bar = $('pipeline-bar');
  const legend = $('pipeline-legend');
  const open = state.jobs.filter(j => j.stage !== 'complete');
  const counts = STAGES.slice(0, 5).map(s => ({ stage: s, count: open.filter(j => j.stage === s).length }));
  const total = counts.reduce((s, c) => s + c.count, 0);

  if (!total) {
    bar.innerHTML = '';
    legend.innerHTML = '<span class="muted">No open jobs — pipeline is clear.</span>';
    return;
  }
  bar.innerHTML = counts.filter(c => c.count > 0).map(c =>
    `<div class="pipeline-seg" style="width:${(c.count / total) * 100}%;background:var(--${STAGE_VAR[c.stage]})" title="${STAGE_LABEL[c.stage]}: ${c.count}"></div>`
  ).join('');
  legend.innerHTML = counts.map(c =>
    `<span><span class="pl-dot" style="background:var(--${STAGE_VAR[c.stage]})"></span>${STAGE_LABEL[c.stage]} <span class="mono">${c.count}</span></span>`
  ).join('');
}

function renderToday() {
  const list = $('today-list');
  const empty = $('today-empty');
  const today = isoToday();

  const jobItems = state.jobs
    .filter(j => j.stage !== 'complete' && ((j.due_date && j.due_date <= today) || (j.install_date && j.install_date <= today)))
    .map(j => {
      const relevant = (j.install_date && j.install_date <= today) ? j.install_date : j.due_date;
      return {
        label: `${txt(j.job_name, 'Job')} — ${STAGE_LABEL[j.stage] || txt(j.stage)}`,
        tag: relevant < today ? 'overdue' : 'today',
        flag: j.on_hold ? '⏸ waiting on material' : installWeatherFlag(j),
        sort: txt(relevant),
      };
    });

  const taskItems = state.tasks
    .filter(t => !t.job_id && !t.completed && t.due_date && t.due_date <= today)
    .map(t => ({
      label: txt(t.title, 'Task'),
      tag: t.due_date < today ? 'overdue' : 'today',
      flag: null,
      sort: txt(t.due_date),
    }));

  const combined = [...jobItems, ...taskItems].sort((a, b) => a.sort.localeCompare(b.sort));
  list.innerHTML = '';
  empty.hidden = combined.length > 0;

  for (const item of combined) {
    const li = document.createElement('li');
    li.className = 'today-item';
    li.innerHTML = `<span class="t-label">${esc(item.label)}</span><span class="t-tag ${item.tag}">${item.tag}</span>${item.flag ? `<span class="t-flag">${esc(item.flag)}</span>` : ''}`;
    list.appendChild(li);
  }
}

// ---------- weather ----------

function installWeatherFlag(job) {
  if (!job.install_date || job.stage === 'complete') return null;
  const day = state.forecast[job.install_date];
  if (day && day.inclement) return `⚠ ${day.reason} on install day`;
  return null;
}

async function loadWeather() {
  if (!state.settings) return;
  const lat = num(state.settings.lat, 34.9265);
  const lon = num(state.settings.lon, -86.5847);
  $('wc-loc').textContent = txt(state.settings.location_name);
  $('weather-loc-label').textContent = txt(state.settings.location_name);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`
      + `&hourly=temperature_2m,precipitation_probability,weather_code&forecast_hours=12`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    const data = await res.json();

    const cur = data.current || {};
    state.current = {
      temp: Math.round(num(cur.temperature_2m)),
      feels: Math.round(num(cur.apparent_temperature)),
      humidity: Math.round(num(cur.relative_humidity_2m)),
      wind: Math.round(num(cur.wind_speed_10m)),
      code: num(cur.weather_code),
    };

    state.hourly = [];
    const h = data.hourly || {};
    (h.time || []).forEach((t, i) => {
      const dt = new Date(t);
      state.hourly.push({
        label: dt.toLocaleTimeString(undefined, { hour: 'numeric' }),
        temp: Math.round(num((h.temperature_2m || [])[i])),
        precip: Math.round(num((h.precipitation_probability || [])[i])),
        code: num((h.weather_code || [])[i]),
      });
    });

    state.forecast = {};
    const d = data.daily || {};
    (d.time || []).forEach((date, i) => {
      const code = num((d.weather_code || [])[i]);
      const precip = Math.round(num((d.precipitation_probability_max || [])[i]));
      const wind = Math.round(num((d.wind_speed_10m_max || [])[i]));
      let reason = null;
      if (STORM_CODES.includes(code)) reason = 'storms';
      else if (SNOW_CODES.includes(code)) reason = 'snow';
      else if (precip >= 50) reason = 'rain likely';
      else if (wind >= 20) reason = 'high wind';
      state.forecast[date] = {
        code,
        hi: Math.round(num((d.temperature_2m_max || [])[i])),
        lo: Math.round(num((d.temperature_2m_min || [])[i])),
        precip,
        wind,
        inclement: !!reason,
        reason: reason || '',
      };
    });

    renderWeather();
    renderJobs();
    renderToday();
  } catch (err) {
    $('weather-now').innerHTML = '<span class="muted">Weather unavailable right now.</span>';
  }
}

function renderWeather() {
  const c = state.current;
  if (c) {
    $('wc-icon').textContent = weatherIcon(c.code);
    $('wc-temp').textContent = `${c.temp}°F`;
    $('weather-now').innerHTML = `
      <span class="wn-icon">${weatherIcon(c.code)}</span>
      <span class="wn-temp">${c.temp}°F</span>
      <div class="wn-details">
        <span>Feels like <strong>${c.feels}°</strong></span>
        <span>Wind <strong>${c.wind} mph</strong></span>
        <span>Humidity <strong>${c.humidity}%</strong></span>
      </div>
    `;
    showAdvisory(c);
  }

  $('hourly-strip').innerHTML = state.hourly.map(h => `
    <div class="hour-cell">
      <div class="hour-label">${esc(h.label)}</div>
      <div class="hour-icon">${weatherIcon(h.code)}</div>
      <div class="hour-temp">${h.temp}°</div>
      <div class="hour-precip">${h.precip > 0 ? h.precip + '%' : '&nbsp;'}</div>
    </div>
  `).join('');

  const dates = Object.keys(state.forecast).sort();
  $('forecast-row').innerHTML = dates.map(date => {
    const day = state.forecast[date];
    const label = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    const installs = state.jobs.filter(j => j.stage !== 'complete' && j.install_date === date);
    const installChips = installs.map(j =>
      `<button type="button" class="day-install-chip" data-job="${j.id}" title="Install: ${esc(j.job_name)} — ${esc(j.customer)}">🚚 ${esc(txt(j.job_name, 'Job'))}</button>`
    ).join('');
    return `
      <div class="day-card${day.inclement ? ' inclement' : ''}">
        <div class="day-name">${esc(label)}</div>
        <div class="day-icon">${weatherIcon(day.code)}</div>
        <div class="day-temps">${day.hi}° <span class="lo">${day.lo}°</span></div>
        <div class="day-meta">💧${day.precip}% · ${day.wind}mph</div>
        ${day.inclement ? `<div class="day-flag">⚠ ${esc(day.reason)}</div>` : ''}
        ${installChips ? `<div class="day-installs">${installChips}</div>` : ''}
      </div>
    `;
  }).join('');

  $('forecast-row').querySelectorAll('[data-job]').forEach(btn => {
    btn.addEventListener('click', () => openJobModal(num(btn.dataset.job)));
  });
}

function showAdvisory(c) {
  const el = $('weather-advisory');
  let msg = null;
  if (STORM_CODES.includes(c.code)) msg = 'Storms nearby — outdoor installs are a bad idea today.';
  else if (SNOW_CODES.includes(c.code)) msg = 'Snow or ice — reschedule outdoor install work if you can.';
  else if (RAIN_CODES.includes(c.code)) msg = 'Wet conditions — exterior installs and wraps will fight you today.';
  else if (c.wind >= 20) msg = `Wind around ${c.wind} mph — banner and yard sign installs won't be fun.`;
  else if (c.temp < 50) msg = `${c.temp}°F — vinyl adhesion gets iffy below 50°F; consider pushing exterior installs.`;
  else if (c.temp > 95) msg = `${c.temp}°F — watch for curling prints and laminate silvering in this heat.`;
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------- jobs ----------

function matchesSearch(job) {
  if (!state.search) return true;
  const q = state.search;
  return txt(job.job_name).toLowerCase().includes(q)
    || txt(job.customer).toLowerCase().includes(q)
    || txt(job.assigned_to).toLowerCase().includes(q)
    || woNum(job.id).toLowerCase().includes(q);
}

async function loadJobs() {
  state.jobs = await api('/api/jobs');
  renderJobs();
  renderDashboard();
  renderWeather();
  updateDatalists();
}

function daysInStage(job) {
  const since = job.stage_changed_at || job.created_at;
  if (!since) return null;
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

function jobChecklist(jobId) {
  return state.tasks.filter(t => t.job_id === jobId);
}

function renderJobs() {
  const list = $('job-list');
  const kanban = $('kanban');
  const calendar = $('calendar');
  const empty = $('jobs-empty');
  if (!list) return;

  const isKanban = state.view === 'kanban';
  const isCal = state.view === 'calendar';
  list.hidden = isKanban || isCal;
  kanban.hidden = !isKanban;
  calendar.hidden = !isCal;

  document.querySelectorAll('.view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === state.view));

  renderStageChips();
  renderSubstrateChips();

  if (isCal) { renderCalendar(); empty.hidden = true; return; }
  if (isKanban) { renderKanban(); empty.hidden = true; return; }

  let filtered = state.activeStage === 'all'
    ? state.jobs
    : state.jobs.filter(j => j.stage === state.activeStage);
  if (state.activeSubstrate !== 'all') {
    filtered = filtered.filter(j => txt(j.substrate) === state.activeSubstrate);
  }
  filtered = filtered.filter(matchesSearch);

  list.innerHTML = '';
  empty.hidden = filtered.length > 0;

  if (state.batchMode) {
    const groups = new Map();
    for (const job of filtered) {
      const key = txt(job.substrate);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const key of keys) {
      const header = document.createElement('li');
      header.className = 'batch-header';
      header.innerHTML = `<span>${esc(key ? (SUBSTRATE_LABEL[key] || key) : 'No substrate set')}</span><span class="batch-count">${groups.get(key).length}</span>`;
      list.appendChild(header);
      groups.get(key).forEach(j => list.appendChild(jobCard(j)));
    }
  } else {
    filtered.forEach(j => list.appendChild(jobCard(j)));
  }
}

function renderStageChips() {
  const wrap = $('stage-chips');
  const chips = [{ key: 'all', label: 'All' }, ...STAGES.map(s => ({ key: s, label: STAGE_LABEL[s] }))];
  wrap.innerHTML = chips.map(c => {
    const count = c.key === 'all' ? '' : state.jobs.filter(j => j.stage === c.key && (c.key === 'complete' || true)).length;
    const show = c.key !== 'all' && c.key !== 'complete' && count > 0;
    return `<button type="button" class="chip${state.activeStage === c.key ? ' active' : ''}" data-stage="${c.key}">${c.label}${show ? ` <span class="cnt">${count}</span>` : ''}</button>`;
  }).join('');
  wrap.querySelectorAll('[data-stage]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeStage = btn.dataset.stage;
      if (state.view === 'calendar' || state.view === 'kanban') {
        state.view = 'list';
        localStorage.setItem('cutline-view', 'list');
      }
      renderJobs();
    });
  });
}

function renderSubstrateChips() {
  const wrap = $('substrate-chips');
  const present = [...new Set(state.jobs.filter(j => j.stage !== 'complete' && j.substrate).map(j => j.substrate))];
  if (state.activeSubstrate !== 'all' && !present.includes(state.activeSubstrate)) {
    state.activeSubstrate = 'all';
  }
  if (!present.length) { wrap.innerHTML = ''; return; }

  const chips = present.sort().map(sub => {
    const count = state.jobs.filter(j => j.stage !== 'complete' && j.substrate === sub).length;
    return `<button type="button" class="chip${state.activeSubstrate === sub ? ' active' : ''}" data-sub="${sub}">${SUBSTRATE_LABEL[sub] || sub} <span class="cnt">${count}</span></button>`;
  }).join('');

  wrap.innerHTML = `<span class="row-label">Material</span>`
    + `<button type="button" class="chip${state.activeSubstrate === 'all' ? ' active' : ''}" data-sub="all">All</button>`
    + chips
    + `<button type="button" class="chip batch${state.batchMode ? ' active' : ''}" id="batch-toggle">Batch by material</button>`;

  wrap.querySelectorAll('[data-sub]').forEach(btn => {
    btn.addEventListener('click', () => { state.activeSubstrate = btn.dataset.sub; renderJobs(); });
  });
  const bt = $('batch-toggle');
  if (bt) bt.addEventListener('click', () => { state.batchMode = !state.batchMode; renderJobs(); });
}

function badgeRow(job, compact = false) {
  const today = isoToday();
  const overdue = job.stage !== 'complete' && job.due_date && job.due_date < today;
  const age = daysInStage(job);
  const flag = installWeatherFlag(job);
  const items = jobChecklist(job.id);
  const done = items.filter(t => t.completed).length;

  const parts = [];
  if (job.substrate) parts.push(`<span class="sub-pill sub-${esc(job.substrate)}">${esc(SUBSTRATE_LABEL[job.substrate] || job.substrate)}</span>`);
  if (job.on_hold && job.stage !== 'complete') parts.push(`<span class="badge hold">⏸ waiting on material</span>`);
  if (job.due_date) parts.push(`<span class="badge${overdue ? ' overdue' : ''}">${overdue ? '⚠ overdue — ' : ''}due ${esc(job.due_date)}</span>`);
  if (job.install_date && !compact) parts.push(`<span class="badge">install ${esc(job.install_date)}</span>`);
  if (job.priority === 'high') parts.push(`<span class="badge prio">high</span>`);
  if (age !== null && age >= 1 && job.stage !== 'complete') {
    parts.push(`<span class="badge${age >= STALE_DAYS ? ' stale' : ''}">${age}d in ${esc(STAGE_LABEL[job.stage] || job.stage)}</span>`);
  }
  if (items.length) parts.push(`<span class="badge check${done === items.length ? ' done' : ''}">☑ ${done}/${items.length}</span>`);
  if (flag) parts.push(`<span class="badge weather">${esc(flag)}</span>`);
  if (job.assigned_to) parts.push(`<span class="avatar"><i>${esc(initials(job.assigned_to))}</i>${esc(job.assigned_to)}</span>`);
  return parts.join('');
}

function jobCard(job) {
  const li = document.createElement('li');
  li.className = 'job-card'
    + (job.stage === 'complete' ? ' complete' : '')
    + (job.on_hold && job.stage !== 'complete' ? ' on-hold' : '');

  const top = document.createElement('div');
  top.className = 'job-top';

  const left = document.createElement('div');
  left.className = 'job-left';
  left.title = 'Open job details';
  left.innerHTML = `
    <div class="job-wo">${woNum(job.id)}</div>
    <p class="job-name">${esc(txt(job.job_name))}</p>
    <p class="job-cust">${esc(txt(job.customer))}</p>
  `;
  left.addEventListener('click', () => openJobModal(job.id));

  const btns = document.createElement('div');
  btns.className = 'job-btns';

  const hold = document.createElement('button');
  hold.className = 'hold-btn' + (job.on_hold ? ' held' : '');
  hold.title = job.on_hold ? 'Release hold' : 'Put on hold — waiting on material';
  hold.textContent = '⏸';
  hold.addEventListener('click', async () => {
    await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ on_hold: job.on_hold ? 0 : 1 }) });
    loadJobs();
  });

  const del = document.createElement('button');
  del.className = 'x-btn';
  del.title = 'Delete job';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
    loadJobs();
  });

  btns.appendChild(hold);
  btns.appendChild(del);
  top.appendChild(left);
  top.appendChild(btns);

  const badges = document.createElement('div');
  badges.className = 'badge-row';
  badges.innerHTML = badgeRow(job);

  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  const currentIdx = STAGES.indexOf(job.stage);
  STAGES.forEach((stage, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step' + (i < currentIdx ? ' done' : '') + (i === currentIdx ? ' current' : '');
    btn.title = `Move to ${STAGE_LABEL[stage]}`;
    btn.innerHTML = `<span class="step-dot"></span><span class="step-label">${STAGE_LABEL[stage]}</span>`;
    btn.addEventListener('click', async () => {
      await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ stage }) });
      loadJobs();
    });
    stepper.appendChild(btn);
  });

  li.appendChild(top);
  li.appendChild(badges);
  li.appendChild(stepper);
  return li;
}

// ---------- kanban ----------

function renderKanban() {
  const kanban = $('kanban');
  kanban.innerHTML = '';
  let jobs = state.jobs.filter(matchesSearch);
  if (state.activeSubstrate !== 'all') {
    jobs = jobs.filter(j => txt(j.substrate) === state.activeSubstrate);
  }

  for (const stage of STAGES) {
    const col = document.createElement('div');
    col.className = 'kanban-col' + (stage === 'complete' ? ' col-complete' : '');
    const inStage = jobs.filter(j => j.stage === stage);
    col.innerHTML = `
      <div class="kanban-col-head" style="color:var(--${STAGE_VAR[stage]})">
        <span>${STAGE_LABEL[stage]}</span><span class="kcount">${inStage.length}</span>
      </div>
      <div class="kanban-col-body"></div>
    `;
    const body = col.querySelector('.kanban-col-body');
    inStage.forEach(j => body.appendChild(kanbanCard(j)));

    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const job = state.jobs.find(j => j.id === parseInt(id, 10));
      if (!job || job.stage === stage) return;
      await api(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ stage }) });
      loadJobs();
    });

    kanban.appendChild(col);
  }
}

function kanbanCard(job) {
  const card = document.createElement('div');
  card.className = 'kanban-card'
    + (job.on_hold && job.stage !== 'complete' ? ' on-hold' : '')
    + (job.priority === 'high' ? ' prio-high' : '');
  card.draggable = true;
  card.innerHTML = `
    <div class="job-wo">${woNum(job.id)}</div>
    <p class="job-name">${esc(txt(job.job_name))}</p>
    <p class="job-cust">${esc(txt(job.customer))}</p>
    <div class="badge-row">${badgeRow(job, true)}</div>
  `;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(job.id));
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => openJobModal(job.id));
  return card;
}

// ---------- calendar ----------

function renderCalendar() {
  const title = $('cal-title');
  const grid = $('cal-grid');
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  title.textContent = state.calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  grid.innerHTML = '';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(wd => {
    const el = document.createElement('div');
    el.className = 'cal-weekday';
    el.textContent = wd;
    grid.appendChild(el);
  });

  const first = new Date(y, m, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  const today = isoToday();
  const active = state.jobs.filter(j => j.stage !== 'complete' && matchesSearch(j));

  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cal-cell'
      + (d.getMonth() === m ? '' : ' cal-outside')
      + (iso === today ? ' cal-today-cell' : '');

    const weather = state.forecast[iso];
    cell.innerHTML = `<div class="cal-daynum">${d.getDate()}${weather && weather.inclement ? ` <span class="cal-warn" title="${esc(weather.reason)}">⚠</span>` : ''}</div>`;

    active.filter(j => j.due_date === iso).forEach(j => cell.appendChild(calChip(j, 'due')));
    active.filter(j => j.install_date === iso).forEach(j => cell.appendChild(calChip(j, 'install')));
    grid.appendChild(cell);
  }
}

function calChip(job, kind) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `cal-chip ${kind}`;
  chip.title = `${txt(job.job_name)} — ${txt(job.customer)} (${kind})`;
  chip.textContent = txt(job.job_name, 'Job');
  chip.addEventListener('click', () => openJobModal(job.id));
  return chip;
}

$('cal-prev').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('cal-next').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('cal-today').addEventListener('click', () => {
  state.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  renderCalendar();
});

// ---------- view switch / search / add job ----------

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view || 'list';
    localStorage.setItem('cutline-view', state.view);
    if (location.hash !== '#jobs') location.hash = '#jobs';
    renderJobs();
    route();
  });
});

$('job-search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderJobs();
});

$('job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customer = $('job-customer').value.trim();
  const jobName = $('job-name').value.trim();
  if (!customer || !jobName) return;
  await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      customer,
      job_name: jobName,
      substrate: $('job-substrate').value || '',
      due_date: $('job-due').value || null,
      install_date: $('job-install').value || null,
      priority: $('job-priority').value || 'medium',
      assigned_to: $('job-assigned').value.trim(),
    }),
  });
  $('job-form').reset();
  $('job-priority').value = 'medium';
  loadJobs();
});

function updateDatalists() {
  const customers = new Set();
  const assignees = new Set();
  state.jobs.forEach(j => { if (j.customer) customers.add(j.customer); if (j.assigned_to) assignees.add(j.assigned_to); });
  state.quotes.forEach(q => { if (q.customer) customers.add(q.customer); });
  $('customer-list').innerHTML = [...customers].sort().map(n => `<option value="${esc(n)}"></option>`).join('');
  $('assignee-list').innerHTML = [...assignees].sort().map(n => `<option value="${esc(n)}"></option>`).join('');
}

// ---------- job modal ----------

const jobModal = $('job-modal');

function openJobModal(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  state.modalJobId = jobId;

  $('jm-wo').textContent = `${woNum(job.id)} — ${STAGE_LABEL[job.stage] || txt(job.stage)}`;
  $('jm-title').textContent = txt(job.job_name, 'Job');
  $('jm-customer').textContent = txt(job.customer);
  $('jm-assigned').value = txt(job.assigned_to);
  $('jm-substrate').value = txt(job.substrate);
  $('jm-priority').value = txt(job.priority, 'medium');
  $('jm-due').value = txt(job.due_date);
  $('jm-install').value = txt(job.install_date);
  $('jm-notes').value = txt(job.notes);
  renderModalChecklist();
  jobModal.showModal();
}

function renderModalChecklist() {
  const list = $('jm-checklist');
  const progress = $('jm-progress');
  const items = jobChecklist(state.modalJobId);
  list.innerHTML = '';
  const done = items.filter(t => t.completed).length;
  progress.textContent = items.length ? `${done}/${items.length} done` : 'nothing yet';

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'check-item' + (item.completed ? ' completed' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.completed;
    cb.addEventListener('change', async () => {
      await api(`/api/tasks/${item.id}`, { method: 'PATCH', body: JSON.stringify({ completed: cb.checked ? 1 : 0 }) });
      await loadTasks();
      renderModalChecklist();
    });

    const span = document.createElement('span');
    span.className = 'c-title';
    span.textContent = txt(item.title);

    const del = document.createElement('button');
    del.className = 'x-btn';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await api(`/api/tasks/${item.id}`, { method: 'DELETE' });
      await loadTasks();
      renderModalChecklist();
    });

    li.appendChild(cb);
    li.appendChild(span);
    li.appendChild(del);
    list.appendChild(li);
  }
}

$('jm-check-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('jm-check-input');
  const title = input.value.trim();
  if (!title || !state.modalJobId) return;
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, job_id: state.modalJobId }) });
  input.value = '';
  await loadTasks();
  renderModalChecklist();
});

$('jm-save').addEventListener('click', async () => {
  if (!state.modalJobId) return;
  await api(`/api/jobs/${state.modalJobId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      assigned_to: $('jm-assigned').value.trim(),
      substrate: $('jm-substrate').value || '',
      priority: $('jm-priority').value || 'medium',
      due_date: $('jm-due').value || null,
      install_date: $('jm-install').value || null,
      notes: $('jm-notes').value,
    }),
  });
  jobModal.close();
  loadJobs();
});

$('jm-delete').addEventListener('click', async () => {
  if (!state.modalJobId) return;
  await api(`/api/jobs/${state.modalJobId}`, { method: 'DELETE' });
  jobModal.close();
  loadJobs();
});

$('jm-close').addEventListener('click', () => jobModal.close());
$('jm-cancel').addEventListener('click', () => jobModal.close());

$('jm-print').addEventListener('click', () => {
  const job = state.jobs.find(j => j.id === state.modalJobId);
  if (!job) return;
  const shop = state.settings ? txt(state.settings.shop_name, 'Sign Shop') : 'Sign Shop';
  const items = jobChecklist(job.id);
  const checklistHtml = items.length
    ? `<h3>Checklist</h3><ul class="print-checklist">${items.map(t => `<li>${t.completed ? '☑' : '☐'} ${esc(txt(t.title))}</li>`).join('')}</ul>`
    : '';
  printHtml(`
    <div class="print-doc">
      <div class="print-head"><h1>${esc(shop)}</h1><div><strong class="print-wo">${woNum(job.id)}</strong></div></div>
      <h2>${esc(txt(job.job_name))}</h2>
      <table class="print-table print-kv">
        <tr><th>Customer</th><td>${esc(txt(job.customer))}</td></tr>
        <tr><th>Stage</th><td>${esc(STAGE_LABEL[job.stage] || txt(job.stage))}</td></tr>
        ${job.substrate ? `<tr><th>Substrate</th><td>${esc(SUBSTRATE_LABEL[job.substrate] || job.substrate)}</td></tr>` : ''}
        ${job.assigned_to ? `<tr><th>Assigned to</th><td>${esc(job.assigned_to)}</td></tr>` : ''}
        ${job.due_date ? `<tr><th>Due</th><td>${esc(job.due_date)}</td></tr>` : ''}
        ${job.install_date ? `<tr><th>Install</th><td>${esc(job.install_date)}</td></tr>` : ''}
        <tr><th>Priority</th><td>${esc(txt(job.priority, 'medium'))}</td></tr>
      </table>
      ${job.notes ? `<h3>Notes</h3><p class="print-notes">${esc(job.notes)}</p>` : ''}
      ${checklistHtml}
      <p class="print-foot">Printed ${new Date().toLocaleString()}</p>
    </div>
  `);
});

// ---------- quotes ----------

const quoteModal = $('quote-modal');

function quoteItemTotal(item) {
  const qty = num(item.qty);
  const rate = num(item.rate);
  if (item.mode === 'flat') return qty * rate;
  return (num(item.w) * num(item.h) / 144) * qty * rate;
}

function quoteTotals(items, taxRate) {
  const subtotal = (items || []).reduce((s, it) => s + quoteItemTotal(it), 0);
  return { subtotal, total: subtotal * (1 + num(taxRate) / 100) };
}

function parseQuoteItems(quote) {
  try {
    const items = JSON.parse(quote.items || '[]');
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

async function loadQuotes() {
  state.quotes = await api('/api/quotes');
  renderQuotes();
  renderKpis();
  updateDatalists();
}

function renderQuotes() {
  const tbody = $('quote-tbody');
  const empty = $('quote-empty');
  tbody.innerHTML = '';
  empty.hidden = state.quotes.length > 0;

  const open = state.quotes.filter(q => q.status === 'draft' || q.status === 'sent');
  const value = open.reduce((s, q) => s + quoteTotals(parseQuoteItems(q), q.tax_rate).total, 0);
  $('quotes-note').textContent = state.quotes.length
    ? `${open.length} open · ${money(value)} in the pipeline`
    : '';

  for (const q of state.quotes) {
    const { total } = quoteTotals(parseQuoteItems(q), q.tax_rate);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${qNum(q.id)}</td>
      <td><strong>${esc(txt(q.title))}</strong></td>
      <td>${esc(txt(q.customer))}</td>
      <td class="num">${money(total)}</td>
      <td><span class="status-pill status-${esc(txt(q.status, 'draft'))}">${esc(txt(q.status, 'draft'))}</span></td>
      <td class="mono">${esc(txt(q.created_at).slice(0, 10))}</td>
      <td>${q.job_id ? `<span class="jobref">${woNum(q.job_id)}</span>` : '<span class="muted">—</span>'}</td>
    `;
    tr.addEventListener('click', () => openQuoteModal(q.id));
    tbody.appendChild(tr);
  }
}

function blankQuoteItem() {
  return { desc: '', mode: 'sqft', w: 24, h: 18, qty: 1, rate: 0 };
}

function openQuoteModal(quoteId) {
  const quote = quoteId ? state.quotes.find(q => q.id === quoteId) : null;
  state.quoteDraft = quote
    ? { id: quote.id, items: parseQuoteItems(quote), status: txt(quote.status, 'draft'), job_id: quote.job_id }
    : { id: null, items: [blankQuoteItem()], status: 'draft', job_id: null };

  $('qm-eyebrow').textContent = quote ? `${qNum(quote.id)} — created ${txt(quote.created_at).slice(0, 10)}` : 'New quote';
  $('qm-customer').value = quote ? txt(quote.customer) : '';
  $('qm-title').value = quote ? txt(quote.title) : '';
  $('qm-tax').value = quote ? num(quote.tax_rate) : 0;
  $('qm-notes').value = quote ? txt(quote.notes) : '';
  $('qm-delete').hidden = !quote;
  $('qm-print').hidden = !quote;

  renderQuoteItems();
  renderQuoteStatusRow();
  quoteModal.showModal();
}

function renderQuoteItems() {
  const wrap = $('qm-items');
  wrap.innerHTML = '';
  state.quoteDraft.items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'qm-item-row';
    row.innerHTML = `
      <input type="text" class="qi-desc" placeholder="Description — e.g. 4×8 ACM sign, printed + laminated" value="${esc(txt(item.desc))}">
      <div class="qm-nums">
        <select class="qi-mode">
          <option value="sqft" ${item.mode !== 'flat' ? 'selected' : ''}>$/sqft</option>
          <option value="flat" ${item.mode === 'flat' ? 'selected' : ''}>flat $</option>
        </select>
        <input type="number" class="qi-w" title="Width (in)" placeholder="W" min="0" step="0.5" value="${num(item.w)}" ${item.mode === 'flat' ? 'disabled' : ''}>
        <input type="number" class="qi-h" title="Height (in)" placeholder="H" min="0" step="0.5" value="${num(item.h)}" ${item.mode === 'flat' ? 'disabled' : ''}>
        <input type="number" class="qi-qty" title="Quantity" placeholder="Qty" min="0" step="1" value="${num(item.qty, 1)}">
        <input type="number" class="qi-rate" title="Rate" placeholder="Rate" min="0" step="0.25" value="${num(item.rate)}">
        <span class="qi-total">${money(quoteItemTotal(item))}</span>
        <button type="button" class="x-btn qi-remove" aria-label="Remove line">×</button>
      </div>
    `;
    const sync = () => {
      item.desc = row.querySelector('.qi-desc').value;
      item.mode = row.querySelector('.qi-mode').value;
      item.w = num(row.querySelector('.qi-w').value);
      item.h = num(row.querySelector('.qi-h').value);
      item.qty = num(row.querySelector('.qi-qty').value);
      item.rate = num(row.querySelector('.qi-rate').value);
      row.querySelector('.qi-w').disabled = item.mode === 'flat';
      row.querySelector('.qi-h').disabled = item.mode === 'flat';
      row.querySelector('.qi-total').textContent = money(quoteItemTotal(item));
      renderQuoteTotals();
    };
    row.querySelectorAll('input, select').forEach(el => el.addEventListener('input', sync));
    row.querySelector('.qi-remove').addEventListener('click', () => {
      state.quoteDraft.items.splice(idx, 1);
      if (!state.quoteDraft.items.length) state.quoteDraft.items.push(blankQuoteItem());
      renderQuoteItems();
    });
    wrap.appendChild(row);
  });
  renderQuoteTotals();
}

function renderQuoteTotals() {
  const { subtotal, total } = quoteTotals(state.quoteDraft.items, $('qm-tax').value);
  $('qm-subtotal').textContent = money(subtotal);
  $('qm-total').textContent = money(total);
}

function renderQuoteStatusRow() {
  const row = $('qm-status-row');
  row.innerHTML = '';
  const draft = state.quoteDraft;
  if (!draft.id) return;

  const pill = document.createElement('span');
  pill.className = `status-pill status-${draft.status}`;
  pill.textContent = draft.status;
  row.appendChild(pill);

  const setStatus = async (s) => {
    await api(`/api/quotes/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ status: s }) });
    await loadQuotes();
    quoteModal.close();
  };

  if (draft.status === 'draft') {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost btn-sm';
    b.textContent = 'Mark sent';
    b.addEventListener('click', () => setStatus('sent'));
    row.appendChild(b);
  }
  if (draft.status !== 'accepted') {
    const accept = document.createElement('button');
    accept.className = 'btn btn-primary btn-sm';
    accept.textContent = 'Accept → create job';
    accept.addEventListener('click', async () => {
      await api(`/api/quotes/${draft.id}/convert`, { method: 'POST' });
      await loadQuotes();
      await loadJobs();
      quoteModal.close();
    });
    row.appendChild(accept);

    const decline = document.createElement('button');
    decline.className = 'btn btn-ghost btn-sm';
    decline.textContent = 'Decline';
    decline.addEventListener('click', () => setStatus('declined'));
    row.appendChild(decline);
  }
  if (draft.status === 'accepted' && draft.job_id) {
    const ref = document.createElement('span');
    ref.className = 'jobref';
    ref.textContent = `→ ${woNum(draft.job_id)}`;
    row.appendChild(ref);
  }
}

$('new-quote-btn').addEventListener('click', () => openQuoteModal(null));
$('qm-add-item').addEventListener('click', () => {
  state.quoteDraft.items.push(blankQuoteItem());
  renderQuoteItems();
});
$('qm-tax').addEventListener('input', renderQuoteTotals);
$('qm-close').addEventListener('click', () => quoteModal.close());
$('qm-cancel').addEventListener('click', () => quoteModal.close());

$('qm-save').addEventListener('click', async () => {
  const customer = $('qm-customer').value.trim();
  const title = $('qm-title').value.trim();
  if (!customer || !title) return;
  const payload = {
    customer,
    title,
    items: state.quoteDraft.items.filter(it => txt(it.desc) || quoteItemTotal(it) > 0),
    tax_rate: num($('qm-tax').value),
    notes: $('qm-notes').value,
  };
  if (state.quoteDraft.id) {
    await api(`/api/quotes/${state.quoteDraft.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  } else {
    await api('/api/quotes', { method: 'POST', body: JSON.stringify(payload) });
  }
  quoteModal.close();
  loadQuotes();
});

$('qm-delete').addEventListener('click', async () => {
  if (!state.quoteDraft.id) return;
  await api(`/api/quotes/${state.quoteDraft.id}`, { method: 'DELETE' });
  quoteModal.close();
  loadQuotes();
});

$('qm-print').addEventListener('click', () => {
  const draft = state.quoteDraft;
  if (!draft.id) return;
  const quote = state.quotes.find(q => q.id === draft.id);
  const taxRate = num($('qm-tax').value);
  const { subtotal, total } = quoteTotals(draft.items, taxRate);
  const shop = state.settings ? txt(state.settings.shop_name, 'Sign Shop') : 'Sign Shop';
  const rows = draft.items.map(it => `
    <tr>
      <td>${esc(txt(it.desc, '—'))}</td>
      <td>${it.mode === 'flat' ? 'flat' : `${num(it.w)}″ × ${num(it.h)}″`}</td>
      <td>${num(it.qty)}</td>
      <td>${money(it.rate)}${it.mode === 'flat' ? '' : '/sqft'}</td>
      <td>${money(quoteItemTotal(it))}</td>
    </tr>`).join('');
  printHtml(`
    <div class="print-doc">
      <div class="print-head">
        <h1>${esc(shop)}</h1>
        <div><strong>QUOTE ${qNum(draft.id)}</strong><br>${quote ? esc(txt(quote.created_at).slice(0, 10)) : ''}</div>
      </div>
      <p><strong>For:</strong> ${esc($('qm-customer').value)}</p>
      <p><strong>Re:</strong> ${esc($('qm-title').value)}</p>
      <table class="print-table">
        <thead><tr><th>Description</th><th>Size</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="print-totals">
        <div>Subtotal: ${money(subtotal)}</div>
        ${taxRate ? `<div>Tax (${taxRate}%): ${money(total - subtotal)}</div>` : ''}
        <div class="print-grand">Total: ${money(total)}</div>
      </div>
      ${$('qm-notes').value ? `<p class="print-notes">${esc($('qm-notes').value)}</p>` : ''}
      <p class="print-foot">Thank you — we appreciate your business.</p>
    </div>
  `);
});

// ---------- printing ----------

function printHtml(html) {
  const area = $('print-area');
  area.innerHTML = html;
  area.hidden = false;
  document.body.classList.add('printing');
  window.print();
  document.body.classList.remove('printing');
  area.hidden = true;
}

// ---------- shop tasks ----------

async function loadTasks() {
  state.tasks = await api('/api/tasks');
  renderTasks();
  renderToday();
  renderJobs();
}

function renderTasks() {
  const list = $('task-list');
  const empty = $('task-empty');
  const visible = state.tasks.filter(t => !t.job_id);
  list.innerHTML = '';
  empty.hidden = visible.length > 0;

  for (const task of visible) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.completed ? ' completed' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!task.completed;
    cb.addEventListener('change', async () => {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completed: cb.checked ? 1 : 0 }) });
      loadTasks();
    });

    const body = document.createElement('div');
    body.className = 'task-body';
    const overdue = !task.completed && task.due_date && task.due_date < isoToday();
    body.innerHTML = `
      <p class="t-title">${esc(txt(task.title))}</p>
      ${(task.due_date || task.priority === 'high') ? `
        <div class="t-meta">
          ${task.due_date ? `<span class="${overdue ? 'overdue' : ''}">${overdue ? 'overdue — ' : 'due '}${esc(task.due_date)}</span>` : ''}
          ${task.priority === 'high' ? '<span class="high">high</span>' : ''}
        </div>` : ''}
    `;

    const del = document.createElement('button');
    del.className = 'x-btn';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
      loadTasks();
    });

    li.appendChild(cb);
    li.appendChild(body);
    li.appendChild(del);
    list.appendChild(li);
  }
}

$('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('task-title').value.trim();
  if (!title) return;
  await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title,
      due_date: $('task-due').value || null,
      priority: $('task-priority').value || 'medium',
    }),
  });
  $('task-form').reset();
  $('task-priority').value = 'medium';
  loadTasks();
});

// ---------- quick notes ----------

async function loadNotes() {
  state.notes = await api('/api/notes');
  renderNotes();
}

function renderNotes() {
  const list = $('note-list');
  const empty = $('note-empty');
  const gList = $('graveyard-list');
  const gToggle = $('graveyard-toggle');
  const gCount = $('graveyard-count');

  const pinned = state.notes.filter(n => !n.resolved);
  const resolved = state.notes.filter(n => n.resolved);

  list.innerHTML = '';
  empty.hidden = pinned.length > 0;
  pinned.forEach(n => list.appendChild(noteChip(n)));

  gList.innerHTML = '';
  resolved.forEach(n => gList.appendChild(noteChip(n)));

  if (resolved.length) {
    gToggle.hidden = false;
    gCount.textContent = `${resolved.length} cleared`;
  } else {
    gToggle.hidden = true;
    gList.hidden = true;
  }
}

function noteChip(note) {
  const li = document.createElement('li');
  li.className = 'note-chip';

  const text = document.createElement('span');
  text.textContent = txt(note.content);

  const actions = document.createElement('span');
  actions.className = 'note-actions';

  const toggle = document.createElement('button');
  toggle.textContent = note.resolved ? '↺' : '✓';
  toggle.title = note.resolved ? 'Restore' : 'Mark done';
  toggle.addEventListener('click', async () => {
    await api(`/api/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: note.resolved ? 0 : 1 }) });
    loadNotes();
  });

  const del = document.createElement('button');
  del.textContent = '×';
  del.title = 'Delete';
  del.addEventListener('click', async () => {
    await api(`/api/notes/${note.id}`, { method: 'DELETE' });
    loadNotes();
  });

  actions.appendChild(toggle);
  actions.appendChild(del);
  li.appendChild(text);
  li.appendChild(actions);
  return li;
}

$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('note-input');
  const content = input.value.trim();
  if (!content) return;
  await api('/api/notes', { method: 'POST', body: JSON.stringify({ content }) });
  input.value = '';
  loadNotes();
});

$('graveyard-toggle').addEventListener('click', () => {
  const gList = $('graveyard-list');
  gList.hidden = !gList.hidden;
});

// ---------- materials ----------

function materialLow(mat) {
  return num(mat.reorder_at) > 0 && num(mat.on_hand) <= num(mat.reorder_at);
}

async function loadMaterials() {
  state.materials = await api('/api/materials');
  renderMaterials();
  renderKpis();
}

function renderMaterials() {
  const grid = $('material-list');
  const empty = $('material-empty');
  grid.innerHTML = '';
  empty.hidden = state.materials.length > 0;

  for (const mat of state.materials) {
    const low = materialLow(mat);
    const onHand = num(mat.on_hand);
    const reorder = num(mat.reorder_at);
    const pct = reorder > 0 ? Math.min(100, Math.round((onHand / (reorder * 2)) * 100)) : 100;

    const card = document.createElement('div');
    card.className = 'm-card' + (low ? ' low' : '');
    card.innerHTML = `
      <div class="m-top">
        <span class="m-name">${esc(txt(mat.name))}</span>
        <span class="m-qty${low ? ' low' : ''}">${onHand} ${esc(txt(mat.unit, 'pcs'))}</span>
      </div>
      <div class="m-meta">${low ? '⚠ reorder now — ' : ''}${reorder > 0 ? `reorder at ${reorder}` : 'no reorder point'}</div>
      <div class="m-bar"><div class="m-bar-fill" style="width:${pct}%;background:${low ? 'var(--warning)' : 'var(--success)'}"></div></div>
      <div class="m-actions"></div>
    `;

    const actions = card.querySelector('.m-actions');
    const step = txt(mat.unit) === 'ft' ? 10 : 1;
    [[`−${step}`, -step, 'Used some'], [`+${step}`, step, 'Received stock']].forEach(([label, delta, title]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', async () => {
        await api(`/api/materials/${mat.id}`, { method: 'PATCH', body: JSON.stringify({ on_hand: Math.max(0, onHand + delta) }) });
        loadMaterials();
      });
      actions.appendChild(b);
    });
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      await api(`/api/materials/${mat.id}`, { method: 'DELETE' });
      loadMaterials();
    });
    actions.appendChild(rm);
    grid.appendChild(card);
  }
}

$('material-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('mat-name').value.trim();
  if (!name) return;
  await api('/api/materials', {
    method: 'POST',
    body: JSON.stringify({
      name,
      on_hand: num($('mat-onhand').value),
      unit: $('mat-unit').value || 'sheets',
      reorder_at: num($('mat-reorder').value),
    }),
  });
  $('material-form').reset();
  loadMaterials();
});

// ---------- equipment ----------

function equipmentDueSoon(eq) {
  if (!eq.last_service) return false;
  const next = new Date(eq.last_service);
  next.setDate(next.getDate() + num(eq.interval_days, 90));
  return Math.round((next - new Date()) / 86400000) <= 7;
}

async function loadEquipment() {
  state.equipment = await api('/api/equipment');
  renderEquipment();
  renderKpis();
}

function renderEquipment() {
  const grid = $('equipment-list');
  const empty = $('equipment-empty');
  grid.innerHTML = '';
  empty.hidden = state.equipment.length > 0;

  for (const eq of state.equipment) {
    let meta = 'No service logged yet';
    let pct = 0;
    let color = 'var(--success)';
    let due = false;

    if (eq.last_service) {
      const interval = num(eq.interval_days, 90);
      const next = new Date(eq.last_service);
      next.setDate(next.getDate() + interval);
      const daysLeft = Math.round((next - new Date()) / 86400000);
      due = daysLeft <= 7;
      meta = daysLeft < 0
        ? `service overdue by ${Math.abs(daysLeft)}d`
        : `next service in ${daysLeft}d (${next.toISOString().slice(0, 10)})`;
      pct = Math.min(100, Math.max(0, Math.round(((interval - daysLeft) / interval) * 100)));
      color = daysLeft < 0 ? 'var(--danger)' : due ? 'var(--warning)' : 'var(--success)';
    }

    const card = document.createElement('div');
    card.className = 'm-card' + (due ? ' low' : '');
    card.innerHTML = `
      <div class="m-top"><span class="m-name">${esc(txt(eq.name))}</span></div>
      <div class="m-meta">${esc(meta)}</div>
      <div class="m-bar"><div class="m-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="m-actions"></div>
    `;
    const actions = card.querySelector('.m-actions');
    const serviced = document.createElement('button');
    serviced.textContent = 'Mark serviced today';
    serviced.addEventListener('click', async () => {
      await api(`/api/equipment/${eq.id}`, { method: 'PATCH', body: JSON.stringify({ last_service: isoToday() }) });
      loadEquipment();
    });
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      await api(`/api/equipment/${eq.id}`, { method: 'DELETE' });
      loadEquipment();
    });
    actions.appendChild(serviced);
    actions.appendChild(rm);
    grid.appendChild(card);
  }
}

$('equipment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('eq-name').value.trim();
  if (!name) return;
  await api('/api/equipment', {
    method: 'POST',
    body: JSON.stringify({
      name,
      interval_days: parseInt($('eq-interval').value, 10) || 90,
      last_service: isoToday(),
    }),
  });
  $('equipment-form').reset();
  $('eq-interval').value = 90;
  loadEquipment();
});

// ---------- settings ----------

const settingsModal = $('settings-modal');

async function loadSettings() {
  state.settings = await api('/api/settings');
  $('shop-name').textContent = txt(state.settings.shop_name, 'The Cutline');
  loadWeather();
}

$('settings-btn').addEventListener('click', () => {
  if (!state.settings) return;
  $('set-shop-name').value = txt(state.settings.shop_name);
  $('set-location-name').value = txt(state.settings.location_name);
  $('set-lat').value = num(state.settings.lat);
  $('set-lon').value = num(state.settings.lon);
  settingsModal.showModal();
});
$('settings-cancel').addEventListener('click', () => settingsModal.close());
$('settings-close').addEventListener('click', () => settingsModal.close());

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      shop_name: $('set-shop-name').value,
      location_name: $('set-location-name').value,
      lat: num($('set-lat').value),
      lon: num($('set-lon').value),
    }),
  });
  $('shop-name').textContent = txt(state.settings.shop_name, 'The Cutline');
  settingsModal.close();
  loadWeather();
});

// ---------- theme ----------

function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('cutline-theme', theme);
}

$('theme-toggle').addEventListener('click', () => {
  const current = localStorage.getItem('cutline-theme') || 'light';
  applyTheme(current === 'light' ? 'dark' : 'light');
});

// ---------- init ----------

$('page-date').textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
});

(async function init() {
  applyTheme(localStorage.getItem('cutline-theme') || 'light');
  await loadSettings();
  await loadJobs();
  await loadTasks();
  await loadEquipment();
  await loadMaterials();
  await loadQuotes();
  await loadNotes();
  route();
})();
