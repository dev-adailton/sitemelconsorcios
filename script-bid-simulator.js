/* ═══════════════════════════════════════════════════════════════
   CONFIGURAÇÃO — altere apenas aqui
═══════════════════════════════════════════════════════════════ */
const CONFIG = {
  // ▼ Cole aqui a URL pública do seu Google Sheets (formato CSV)
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS9g0I4RR_f1O3sKNqQ_K2jdyFU9dmY8t2JdTC3DMG2_UQ5zS9LcR7QNndfmkmsN1mf6Oj0gwYMv0qW/pub?gid=0&single=true&output=csv',

  // Intervalo padrão de auto-refresh em segundos (padrão: 5 min)
  DEFAULT_INTERVAL: 300,

  // Chave usada para cache local
  CACHE_KEY: 'sim_sheet_data',
  CACHE_META_KEY: 'sim_sheet_meta',
  INTERVAL_KEY: 'sim_interval',
  AUTOREFRESH_KEY: 'sim_autorefresh',
};

/* ═══════════════════════════════════════════════════════════════
   ESTADO GLOBAL
═══════════════════════════════════════════════════════════════ */
let ALL_ROWS = [];
let chartInst = null;
let EXPORT_DATA = null;
let _calcLoading = false;

// Auto-refresh
let _refreshTimer = null;
let _countdownTimer = null;
let _refreshInterval = CONFIG.DEFAULT_INTERVAL;
let _refreshEnabled = false;
let _countdownSec = 0;
let _totalSec = CONFIG.DEFAULT_INTERVAL;

/* ═══════════════════════════════════════════════════════════════
   UTILITÁRIOS
═══════════════════════════════════════════════════════════════ */
function el(id) { return document.getElementById(id); }
function showAlert(id, t, m) { const d = el(id); if (!d) return; d.className = 'alert ' + t; d.innerHTML = m; d.classList.remove('d-none'); }
function hideAlert(id) { const d = el(id); if (!d) return; d.className = 'alert d-none'; d.innerHTML = ''; }

function fmt4(v) {
  if (v === null || v === undefined || isNaN(v)) return '-';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
function fmtPct(v) { return fmt4(v) + '%'; }

function parseNum(v) {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim(); if (!s) return NaN;
  if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.indexOf(',') >= 0) s = s.replace(',', '.');
  return Number(s);
}

function normText(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function niceText(v) {
  const map = {
    'lance livre': 'Lance Livre', 'lance limitado': 'Lance Limitado',
    'lance fixo': 'Lance Fixo', '2o lance fixo': '2º Lance Fixo',
    '2º lance fixo': '2º Lance Fixo', 'sorteio': 'Sorteio',
    'cancelada': 'Cancelada', 'veiculos': 'Veículos', 'imoveis': 'Imóveis'
  };
  return map[normText(v)] || String(v || '');
}

function normalizeGrupo(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s;
}

function parseDateAny(str) {
  if (!str) return null;
  const s = String(str).trim(), iso = s.split(' ')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [Y, M, D] = iso.split('-').map(Number);
    return new Date(Y, M - 1, D, 12, 0, 0, 0);
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(iso)) {
    const [D, M, Y] = iso.split('/').map(Number);
    return new Date(Y, M - 1, D, 12, 0, 0, 0);
  }
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return null;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 12, 0, 0, 0);
}

function formatDateBR(str) {
  const dt = parseDateAny(str);
  return dt ? dt.toLocaleDateString('pt-BR') : String(str || '');
}

function formatSecondsLeft(sec) {
  if (sec >= 60) { const m = Math.floor(sec / 60), s = sec % 60; return m + 'm ' + (s < 10 ? '0' : '') + s + 's'; }
  return sec + 's';
}

function recRow(a, b) {
  return '<div class="rec-row"><span>' + a + '</span><span>' + b + '</span></div>';
}

/* ═══════════════════════════════════════════════════════════════
   CONFIG CARD — recolher/expandir
═══════════════════════════════════════════════════════════════ */
el('btnToggleConfig').addEventListener('click', function () {
  const body = el('configBody');
  const collapsed = body.classList.toggle('d-none');
  this.textContent = collapsed ? '▼ Expandir' : '▲ Recolher';
});

/* ═══════════════════════════════════════════════════════════════
   AUTO-REFRESH — engine
═══════════════════════════════════════════════════════════════ */
function updateRefreshUI() {
  const dot = el('refreshDot');
  const text = el('refreshStatusText');
  const wrap = el('countdownWrap');
  if (_refreshEnabled) {
    dot.className = 'dot pulse';
    text.textContent = 'Auto-refresh ativo (' + formatSecondsLeft(_refreshInterval) + ')';
    wrap.classList.remove('d-none');
  } else {
    dot.className = 'dot off';
    text.textContent = 'Dados carregados';
    wrap.classList.add('d-none');
  }
}

function updateCountdownUI() {
  const fill = el('countdownFill'), text = el('countdownText');
  if (!fill || !text) return;
  const pct = (_countdownSec / _totalSec) * 100;
  fill.style.width = pct + '%';
  fill.style.background = _countdownSec <= 10 ? '#f59e0b' : '#4ade80';
  text.textContent = 'Próxima atualização em ' + formatSecondsLeft(_countdownSec);
}

function stopCountdown() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
}

function startCountdown(seconds) {
  stopCountdown();
  _countdownSec = seconds; _totalSec = seconds;
  updateCountdownUI();
  _countdownTimer = setInterval(() => {
    _countdownSec--;
    if (_countdownSec < 0) _countdownSec = _totalSec;
    updateCountdownUI();
  }, 1000);
}

function stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  stopCountdown();
  _refreshEnabled = false;
  el('toggleRefresh').checked = false;
  updateRefreshUI();
  localStorage.setItem(CONFIG.AUTOREFRESH_KEY, '0');
}

function startAutoRefresh() {
  stopAutoRefresh();
  _refreshEnabled = true;
  _refreshInterval = getSelectedInterval();
  _totalSec = _refreshInterval;
  updateRefreshUI();
  localStorage.setItem(CONFIG.AUTOREFRESH_KEY, '1');
  startCountdown(_refreshInterval);
  _refreshTimer = setInterval(() => {
    fetchSheet(false);
    startCountdown(_refreshInterval);
  }, _refreshInterval * 1000);
}

function getSelectedInterval() {
  const active = document.querySelector('.interval-chip.active');
  return active ? parseInt(active.dataset.val) : CONFIG.DEFAULT_INTERVAL;
}

/* ═══════════════════════════════════════════════════════════════
   INTERVAL CHIPS
═══════════════════════════════════════════════════════════════ */
document.querySelectorAll('.interval-chip').forEach(chip => {
  chip.addEventListener('click', function () {
    document.querySelectorAll('.interval-chip').forEach(c => c.classList.remove('active'));
    this.classList.add('active');
    localStorage.setItem(CONFIG.INTERVAL_KEY, this.dataset.val);
    if (_refreshEnabled) startAutoRefresh();
  });
});

el('toggleRefresh').addEventListener('change', function () {
  if (this.checked) startAutoRefresh();
  else stopAutoRefresh();
});

/* ═══════════════════════════════════════════════════════════════
   FETCH GOOGLE SHEETS
═══════════════════════════════════════════════════════════════ */
async function fetchSheet(verbose = true) {
  const url = CONFIG.SHEET_URL;
if (!url || url.includes('SEU_ID_AQUI')) {
    showAlert('alertLoad', 'err',
      '⚠️ Configure a <b>SHEET_URL</b> no arquivo <code>script-bid-simulator.js</code> com a URL pública da sua planilha.');
    el('refreshStatusText').textContent = 'URL não configurada';
    return;
  }

  el('refreshStatusText').textContent = 'Buscando dados...';
  el('refreshDot').className = 'dot pulse';

  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_cb=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status + ' — verifique se a planilha está publicada como CSV.');
    const text = await res.text();
    const total = processSheetText(text);
    const now = new Date().toLocaleString('pt-BR');

    // Persiste cache local
    localStorage.setItem(CONFIG.CACHE_KEY, text);
    localStorage.setItem(CONFIG.CACHE_META_KEY, JSON.stringify({ date: now, total }));

    updateSourceUI(now, total, url);
    hideAlert('alertLoad');

    if (verbose) {
      showAlert('alertLoad', 'ok',
        '✅ <b>' + total + '</b> registros carregados do Google Sheets.<br>Atualizado em: <b>' + now + '</b>');
    }

    restoreSelection();

  } catch (err) {
    el('refreshStatusText').textContent = 'Erro ao atualizar';
    el('refreshDot').className = 'dot off';
    if (verbose) showAlert('alertLoad', 'err', '<b>Erro ao buscar planilha:</b> ' + err.message);
    console.error('[SimuladorConsorcios] fetchSheet error:', err);
  }
}

function updateSourceUI(date, total, url) {
  // topbar
  el('refreshDot').className = _refreshEnabled ? 'dot pulse' : 'dot';
  el('refreshStatusText').textContent = _refreshEnabled
    ? 'Auto-refresh ativo (' + formatSecondsLeft(_refreshInterval) + ')'
    : 'Dados atualizados';
  el('sourceLastUpdate').textContent = '🕐 ' + date + ' · ' + total + ' registros';

  // banner
  el('sourceBanner').classList.remove('d-none');
  el('bannerUrl').textContent = url;
  el('bannerLastUpdate').textContent = 'Última atualização: ' + date + ' · ' + total + ' registros';
}

el('btnRefreshNow').addEventListener('click', () => {
  fetchSheet(true);
  if (_refreshEnabled) startCountdown(_refreshInterval);
});

/* ═══════════════════════════════════════════════════════════════
   CSV PARSER
═══════════════════════════════════════════════════════════════ */
function parseCSVLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(x => x.trim());
  if (!lines.length) throw new Error('Arquivo vazio.');
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const required = ['tipoLance', 'dataContemplacao', 'grupo', 'produto', 'percLance'];
  const missing = required.filter(c => !headers.includes(c));
  if (missing.length) throw new Error('Colunas ausentes na planilha: ' + missing.join(', '));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]), obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] || '').trim(); });
    const grupo = normalizeGrupo(obj.grupo);
    const produtoNorm = normText(obj.produto);
    const tipoNorm = normText(obj.tipoLance);
    const perc = parseNum(obj.percLance);
    const data = String(obj.dataContemplacao || '').trim();
    if (!grupo || !produtoNorm || !tipoNorm || isNaN(perc) || !data) continue;
    rows.push({
      grupo,
      produto: produtoNorm,
      produtoLabel: niceText(obj.produto),
      tipo: tipoNorm,
      tipoLabel: niceText(obj.tipoLance),
      perc, data,
      dateObj: parseDateAny(data),
      assembleiaAtual: String(obj.assembleiaAtual || '').trim(),
      assembleiaRealizar: String(obj.assembleiaRealizar || '').trim(),
      faixaCredito: String(obj.faixaCredito || '').trim()
    });
  }
  if (!rows.length) throw new Error('Nenhum registro válido encontrado. Verifique as colunas da planilha.');
  return rows;
}

function processSheetText(text) {
  const rows = parseCSV(text);
  ALL_ROWS = rows;
  renderProdutoChips();
  return rows.length;
}

/* ═══════════════════════════════════════════════════════════════
   LISTAS DERIVADAS
═══════════════════════════════════════════════════════════════ */
function getProdutos() {
  return [...new Set(ALL_ROWS.map(r => r.produto))].sort();
}

function getGrupos(produto) {
  const mapa = {};
  ALL_ROWS.filter(r => !produto || r.produto === produto).forEach(r => {
    if (!mapa[r.grupo]) mapa[r.grupo] = {
      grupo: r.grupo,
      assembleiaAtual: r.assembleiaAtual,
      assembleiaRealizar: r.assembleiaRealizar,
      faixaCredito: r.faixaCredito
    };
  });
  return Object.values(mapa).sort((a, b) =>
    a.grupo.localeCompare(b.grupo, undefined, { numeric: true })
  );
}

function getTipos(produto, grupo) {
  return [...new Set(
    ALL_ROWS
      .filter(r => (!produto || r.produto === produto) && (!grupo || r.grupo === grupo))
      .map(r => r.tipo)
  )].filter(t => t !== 'cancelada' && t !== 'sorteio').sort();
}

/* ═══════════════════════════════════════════════════════════════
   RENDER CHIPS
═══════════════════════════════════════════════════════════════ */
function renderProdutoChips() {
  const grid = el('produtoGrid'); if (!grid) return;
  const produtos = getProdutos();
  if (!produtos.length) {
    grid.innerHTML = '<span class="placeholder">Nenhum dado disponível</span>';
    return;
  }
  grid.innerHTML = '';
  produtos.forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip';
    chip.textContent = niceText(p); chip.dataset.value = p;
    chip.addEventListener('click', () => selectProduto(p));
    grid.appendChild(chip);
  });
}

function renderGrupoChips(produto) {
  const grid = el('grupoGrid'); if (!grid) return [];
  if (!produto) {
    grid.innerHTML = '<span class="placeholder">Selecione um produto primeiro</span>';
    return [];
  }
  const gruposObj = getGrupos(produto);
  if (!gruposObj.length) {
    grid.innerHTML = '<span class="placeholder">Nenhum grupo para este produto</span>';
    return [];
  }
  grid.innerHTML = '';
  gruposObj.forEach(g => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip';
    const atu = g.assembleiaAtual || '-';
    const rest = g.assembleiaRealizar || '-';
    const cred = g.faixaCredito || '-';
    chip.innerHTML =
      '<span style="font-size:14px;font-weight:900">' + g.grupo + '</span>' +
      '<span style="font-size:11px;opacity:.75;display:block;margin-top:2px">' +
      'Atual: ' + atu + ' · Faltam: ' + rest + ' · Crédito: ' + cred +
      '</span>';
    chip.dataset.value = g.grupo;
    chip.style.borderRadius = '14px';
    chip.style.padding = '10px 16px';
    chip.style.lineHeight = '1';
    chip.addEventListener('click', () => selectGrupo(g.grupo));
    grid.appendChild(chip);
  });
  return gruposObj.map(g => g.grupo);
}

function renderTipos(produto, grupo) {
  const sel = el('selTipo'); if (!sel) return;
  const tipos = getTipos(produto, grupo);
  sel.innerHTML = '<option value="">— selecione —</option>';
  tipos.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = niceText(t);
    sel.appendChild(opt);
  });
  if (tipos.includes('lance livre')) sel.value = 'lance livre';
}

/* ═══════════════════════════════════════════════════════════════
   SELEÇÃO produto / grupo
═══════════════════════════════════════════════════════════════ */
function selectProduto(produto) {
  el('produtoSel').value = produto;
  document.querySelectorAll('#produtoGrid .chip')
    .forEach(c => c.classList.toggle('active', c.dataset.value === produto));
  const grupos = renderGrupoChips(produto);
  if (grupos.length) {
    el('grupoSel').value = grupos[0];
    document.querySelectorAll('#grupoGrid .chip')
      .forEach(c => c.classList.toggle('active', c.dataset.value === grupos[0]));
    renderTipos(produto, grupos[0]);
  } else {
    el('grupoSel').value = '';
    renderTipos(produto, '');
  }
  el('percLance').value = '';
  tryAutoCalc();
}

function selectGrupo(grupo) {
  const produto = el('produtoSel').value;
  el('grupoSel').value = grupo;
  document.querySelectorAll('#grupoGrid .chip')
    .forEach(c => c.classList.toggle('active', c.dataset.value === grupo));
  renderTipos(produto, grupo);
  tryAutoCalc();
}

/* ═══════════════════════════════════════════════════════════════
   RESTAURAR SELEÇÃO após refresh
═══════════════════════════════════════════════════════════════ */
function restoreSelection() {
  const pAtual = el('produtoSel').value;
  const gAtual = el('grupoSel').value;
  const prods = getProdutos();
  if (!prods.length) return;
  if (pAtual && prods.includes(pAtual)) {
    selectProduto(pAtual);
    setTimeout(() => { if (gAtual) selectGrupo(gAtual); }, 30);
  } else {
    selectProduto(prods[0]);
  }
}

/* ═══════════════════════════════════════════════════════════════
   AUTO-CALC
═══════════════════════════════════════════════════════════════ */
function tryAutoCalc() {
  const p = el('produtoSel').value;
  const g = el('grupoSel').value;
  const t = el('selTipo').value;
  if (p && g && t) el('btnCalc').click();
}

/* ═══════════════════════════════════════════════════════════════
   LOADING BOTÃO
═══════════════════════════════════════════════════════════════ */
function setCalcLoading(on) {
  const btn = el('btnCalc'); if (!btn) return;
  _calcLoading = on; btn.disabled = on;
  btn.innerHTML = on ? '⏳ Calculando...' : '📊 Calcular Probabilidade';
}

/* ═══════════════════════════════════════════════════════════════
   ESTATÍSTICAS
═══════════════════════════════════════════════════════════════ */
function calcStats(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const q = p => {
    const pos = (s.length - 1) * p, base = Math.floor(pos), rest = pos - base;
    return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
  };
  const sum = s.reduce((a, b) => a + b, 0);
  const mid = Math.floor(s.length / 2);
  return {
    min: s[0], max: s[s.length - 1],
    mean: sum / s.length,
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    p25: q(.25), p75: q(.75), p90: q(.90),
    count: s.length
  };
}

/* ═══════════════════════════════════════════════════════════════
   GRÁFICO
═══════════════════════════════════════════════════════════════ */
function drawChart(vals, st, percInput, saturated) {
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  const cvs = el('chart'); if (!cvs) return;
  const ctx = cvs.getContext('2d');
  if (saturated) {
    chartInst = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [fmtPct(st.min)], datasets: [{
          label: 'Contemplações', data: [vals.length],
          backgroundColor: 'rgba(100,116,139,.75)', borderRadius: 8
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { stepSize: 1 } } }
      }
    });
    return;
  }
  const bins = 10, start = st.min - 1, end = st.max + 1, step = (end - start) / bins;
  const labels = [], counts = [], colors = [];
  for (let i = 0; i < bins; i++) {
    const lo = start + i * step, hi = lo + step;
    labels.push(fmt4(lo) + '–' + fmt4(hi));
    counts.push(vals.filter(v => i === bins - 1 ? (v >= lo && v <= hi) : (v >= lo && v < hi)).length);
    colors.push((percInput >= lo && percInput < hi) ? 'rgba(37,99,235,.85)' : 'rgba(148,163,184,.60)');
  }
  chartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels, datasets: [{
        label: 'Contemplações', data: counts,
        backgroundColor: colors, borderRadius: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { stepSize: 1 } }
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   PERÍODO
═══════════════════════════════════════════════════════════════ */
function clearResults() {
  el('resultSection').classList.add('d-none');
  hideAlert('alertCalc');
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  EXPORT_DATA = null;
}

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
function addMonths(b, delta) { return new Date(b.getFullYear(), b.getMonth() + delta, 1, 0, 0, 0, 0); }

function getPeriodoInfo(value, maxDate) {
  if (!maxDate || value === 'all') return { label: 'Todo o histórico', min: null, max: null };
  const ref = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1, 0, 0, 0, 0);
  const map = {
    '1m': { label: 'Último mês', min: startOfMonth(maxDate), max: endOfMonth(maxDate) },
    '3m': { label: '3 meses anteriores', min: addMonths(ref, -2), max: endOfMonth(maxDate) },
    '6m': { label: '6 meses anteriores', min: addMonths(ref, -5), max: endOfMonth(maxDate) },
    '9m': { label: '9 meses anteriores', min: addMonths(ref, -8), max: endOfMonth(maxDate) },
    '12m': { label: '12 meses anteriores', min: addMonths(ref, -11), max: endOfMonth(maxDate) },
  };
  return map[value] || { label: 'Todo o histórico', min: null, max: null };
}

function filterByPeriodo(rows, periodo) {
  if (periodo === 'all') return rows.slice();
  const dated = rows.filter(r => !!r.dateObj);
  if (!dated.length) return [];
  const maxTime = Math.max(...dated.map(r => r.dateObj.getTime()));
  const info = getPeriodoInfo(periodo, new Date(maxTime));
  return rows.filter(r => {
    if (!r.dateObj) return false;
    const t = r.dateObj.getTime();
    return t >= info.min.getTime() && t <= info.max.getTime();
  });
}

function sortByDateAsc(rows) {
  return rows.slice().sort((a, b) => {
    const da = a.dateObj ? a.dateObj.getTime() : 0, db = b.dateObj ? b.dateObj.getTime() : 0;
    return da - db || a.perc - b.perc;
  });
}
function sortByDateDesc(rows) {
  return rows.slice().sort((a, b) => {
    const da = a.dateObj ? a.dateObj.getTime() : 0, db = b.dateObj ? b.dateObj.getTime() : 0;
    return db - da || b.perc - a.perc;
  });
}

/* ═══════════════════════════════════════════════════════════════
   EXPORTAÇÕES
═══════════════════════════════════════════════════════════════ */
window.doExportCSV = function () {
  if (!EXPORT_DATA) return;
  const c = EXPORT_DATA;
  let csv = '\ufeff' + 'Data,Produto,Grupo,Tipo Lance,Percentual (%)\n';
  c.hist.forEach(r => {
    csv += r.data + ',"' + r.produtoLabel + '","' + r.grupo + '","' + r.tipoLabel + '","' + fmt4(r.perc) + '"\n';
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'Historico_G' + c.grupo + '.csv'; a.click();
  URL.revokeObjectURL(url);
};

window.doExportPDF = function () {
  if (!EXPORT_DATA) return;
  const c = EXPORT_DATA;
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('Aguarde a biblioteca PDF carregar...'); return; }
  const doc = new window.jspdf.jsPDF();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(30, 58, 138);
  doc.text('Relatório de Simulação de Contemplação', 14, 20);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(71, 85, 105);
  doc.text('Produto: ' + c.produtoLabel + ' | Grupo: ' + c.grupo + ' | Tipo: ' + c.tipoLabel, 14, 28);
  doc.text('Período: ' + c.periodoInfo.label + ' (' + c.primeiraDataStr + ' a ' + c.ultimaDataStr + ')', 14, 34);
  doc.text('Total de ocorrências: ' + c.filtered.length, 14, 40);
  doc.setDrawColor(226, 232, 240); doc.setFillColor(248, 250, 252);
  doc.roundedRect(14, 46, 182, 34, 3, 3, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(15, 23, 42);
  doc.text('Lance Simulado: ' + fmtPct(c.percInput), 20, 56);
  const chanceText = c.saturated ? 'Análise: Grupo Saturado' : 'Probabilidade Histórica: ' + Math.round(c.prob) + '%';
  doc.setFontSize(16);
  if (c.prob >= 80 && !c.saturated) doc.setTextColor(22, 101, 52);
  else if (c.prob >= 50 && !c.saturated) doc.setTextColor(161, 98, 7);
  else if (!c.saturated) doc.setTextColor(153, 27, 27);
  doc.text(chanceText, 20, 68);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(15, 23, 42);
  doc.text('Indicadores do Grupo', 14, 94);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(71, 85, 105);
  doc.text('Mín: ' + fmtPct(c.st.min) + ' | Mediana: ' + fmtPct(c.st.median) + ' | Máx: ' + fmtPct(c.st.max), 14, 102);
  doc.text('Média: ' + fmtPct(c.st.mean) + ' | Q1: ' + fmtPct(c.st.p25) + ' | Q3: ' + fmtPct(c.st.p75), 14, 108);
  const tableData = c.hist.map(r => {
    const d = r.perc - c.percInput;
    const tag = Math.abs(d) < 0.00005 ? 'Empatado' : d > 0 ? '+' + fmt4(d) + '% maior' : '-' + fmt4(Math.abs(d)) + '% menor';
    return [formatDateBR(r.data), fmtPct(r.perc), tag];
  });
  doc.autoTable({
    startY: 118,
    head: [['Data', '% Lance', 'Vs. Seu Lance']],
    body: tableData, theme: 'grid',
    headStyles: { fillColor: [37, 99, 235], fontSize: 10, textColor: [255, 255, 255] },
    bodyStyles: { fontSize: 10 },
    alternateRowStyles: { fillColor: [248, 250, 252] }
  });
  doc.save('Relatorio_G' + c.grupo + '.pdf');
};

/* ═══════════════════════════════════════════════════════════════
   LISTENERS — filtros
═══════════════════════════════════════════════════════════════ */
el('selPeriodo').addEventListener('change', tryAutoCalc);

el('selTipo').addEventListener('change', () => {
  el('percLance').value = '';
  tryAutoCalc();
});

el('percLance').addEventListener('blur', function () { if (this.value) tryAutoCalc(); });
el('percLance').addEventListener('keypress', e => { if (e.key === 'Enter') tryAutoCalc(); });

el('btnClear').addEventListener('click', clearResults);

/* ═══════════════════════════════════════════════════════════════
   CALCULAR
═══════════════════════════════════════════════════════════════ */
el('btnCalc').addEventListener('click', function () {
  if (_calcLoading) return;
  hideAlert('alertCalc');
  if (!ALL_ROWS.length) { showAlert('alertCalc', 'err', 'Dados ainda não carregados. Aguarde ou clique em 🔄 Atualizar agora.'); return; }
  const produto = el('produtoSel').value.trim();
  const grupo = el('grupoSel').value.trim();
  const tipo = el('selTipo').value.trim();
  const periodo = el('selPeriodo').value;
  let percInput = parseNum(el('percLance').value);
  if (!produto) { showAlert('alertCalc', 'err', 'Selecione um <b>produto</b>.'); return; }
  if (!grupo) { showAlert('alertCalc', 'err', 'Selecione um <b>grupo</b>.'); return; }
  if (!tipo) { showAlert('alertCalc', 'err', 'Selecione um <b>tipo de lance</b>.'); return; }
  setCalcLoading(true);
  setTimeout(() => { try { _doCalc(produto, grupo, tipo, periodo, percInput); } finally { setCalcLoading(false); } }, 60);
});

/* ═══════════════════════════════════════════════════════════════
   _doCalc — núcleo do cálculo
═══════════════════════════════════════════════════════════════ */
function _doCalc(produto, grupo, tipo, periodo, percInput) {
  const baseFiltered = ALL_ROWS.filter(r =>
    r.produto === produto && r.grupo === grupo &&
    r.tipo === tipo && r.tipo !== 'cancelada' && r.tipo !== 'sorteio'
  );
  if (!baseFiltered.length) {
    showAlert('alertCalc', 'err', 'Nenhum histórico encontrado para este produto/grupo/tipo.');
    clearResults(); return;
  }
  const filtered = filterByPeriodo(baseFiltered, periodo);
  if (!filtered.length) {
    showAlert('alertCalc', 'err', 'Nenhum histórico para o <b>período</b> selecionado.');
    clearResults(); return;
  }

  const orderedAsc = sortByDateAsc(filtered);
  const primeiraDataStr = formatDateBR(orderedAsc[0].data);
  const ultimaDataStr = formatDateBR(orderedAsc[orderedAsc.length - 1].data);
  const vals = filtered.map(r => r.perc);
  const st = calcStats(vals);

  let autoSug = null;
  if (isNaN(percInput)) { autoSug = (st.max - st.min < 0.5) ? st.min : st.p75; percInput = autoSug; }

  const spread = st.max - st.min;
  const saturated = spread < 0.5;
  const semi = !saturated && spread <= 5;
  const matches = vals.filter(v => v <= percInput).length;
  const prob = (matches / vals.length) * 100;

  // Badge
  let badgeClass = 'badge-ok', badgeText = 'Grupo Competitivo';
  if (saturated) { badgeClass = 'badge-neu'; badgeText = 'Grupo Saturado (Lance Teto)'; }
  else if (semi) { badgeClass = 'badge-warn'; badgeText = 'Grupo Semi-competitivo'; }

  // Círculo
  let circleClass = 'c-err', mainTitle = 'Chance baixa', mainText = 'Seu lance está abaixo de boa parte do histórico.';
  if (saturated) { circleClass = 'c-neu'; mainTitle = 'Grupo no lance teto'; mainText = 'Todos disputam no mesmo percentual — contemplação por desempate.'; }
  else if (prob >= 80) { circleClass = 'c-ok'; mainTitle = 'Ótimas chances'; mainText = 'Seu lance supera a maior parte do histórico analisado.'; }
  else if (prob >= 50) { circleClass = 'c-warn'; mainTitle = 'Chance intermediária'; mainText = 'Lance competitivo, mas sem ampla vantagem.'; }

  const periodoInfo = getPeriodoInfo(periodo, orderedAsc[orderedAsc.length - 1].dateObj);

  // Grupo meta
  const grupoMetaArr = getGrupos(produto).filter(g => g.grupo === grupo);
  const gm = grupoMetaArr[0] || null;
  const grupoInfoHtml = gm ?
    '<div class="grupo-info-box">' +
    '<b>📋 Grupo ' + grupo + '</b><br>' +
    'Assembleia atual: <b>' + (gm.assembleiaAtual || '—') + '</b> &nbsp;·&nbsp; ' +
    'Assembleias restantes: <b>' + (gm.assembleiaRealizar || '—') + '</b> &nbsp;·&nbsp; ' +
    'Faixa de crédito: <b>' + (gm.faixaCredito || '—') + '</b>' +
    '</div>' : '';

  EXPORT_DATA = {
    filtered, st, prob, saturated, percInput, autoSug,
    produtoLabel: niceText(produto), grupo, tipoLabel: niceText(tipo),
    periodoInfo, primeiraDataStr, ultimaDataStr,
    hist: sortByDateDesc(filtered)
  };

  // ── Card resultado ──
  el('cardRes').innerHTML =
    '<div class="res-header"><div>' +
    '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
    '<div class="res-title">' + mainTitle + '</div>' +
    '<div class="res-text">' + mainText + '</div>' +
    (autoSug !== null ? '<div class="auto-box">💡 Sugestão automática: <b>' + fmtPct(autoSug) + '</b></div>' : '') +
    grupoInfoHtml +
    '<div class="res-meta">' +
    'Produto: <b>' + EXPORT_DATA.produtoLabel + '</b> | Grupo: <b>' + grupo + '</b> | Tipo: <b>' + EXPORT_DATA.tipoLabel + '</b> | Período: <b>' + periodoInfo.label + '</b><br>' +
    'De: <b>' + primeiraDataStr + '</b> até <b>' + ultimaDataStr + '</b> | Registros: <b>' + filtered.length + '</b>' +
    '</div>' +
    '</div>' +
    '<div class="circle ' + circleClass + '">' +
    '<div class="v">' + (saturated ? '—' : Math.round(prob) + '%') + '</div>' +
    '<div class="l">' + (saturated ? 'saturado' : 'chance') + '</div>' +
    '</div></div>';

  // ── Métricas ──
  const mList = [
    ['Mín. histórico', st.min, 'Piso contemplado', ''],
    ['Mediana', st.median, '50% das contemplações', ''],
    ['Máx. histórico', st.max, 'Teto contemplado', ''],
    ['Seu lance', percInput, (percInput - st.min >= 0 ? '+' : '') + fmt4(percInput - st.min) + '% vs. mínimo', 'highlight'],
    ['Média histórica', st.mean, 'Média simples', ''],
    ['1º quartil', st.p25, '25% das contemplações abaixo', ''],
    ['3º quartil', st.p75, '75% das contemplações abaixo', ''],
    ['Percentil 90', st.p90, 'Lance muito forte', '']
  ];
  el('metrics').innerHTML = mList.map(m =>
    '<div class="metric ' + m[3] + '">' +
    '<div class="k">' + m[0] + '</div>' +
    '<div class="v">' + fmtPct(m[1]) + '</div>' +
    '<div class="s">' + m[2] + '</div>' +
    '</div>'
  ).join('');

  // ── Recomendação ──
  let cls = 'err', title = 'Oferta Baixa';
  let body = recRow('Seu lance', fmtPct(percInput)) + recRow('Mediana histórica', fmtPct(st.median)) + recRow('Faixa forte', '≥ ' + fmtPct(st.p75)) + recRow('Leitura', 'Abaixo da zona mais competitiva');
  if (saturated) {
    cls = 'neu'; title = 'Análise do Grupo Saturado';
    body = recRow('Lance teto', fmtPct(st.min)) + recRow('Situação', 'Todos ofertam no máximo') + recRow('Diferencial no %', 'Nenhum') + recRow('Estratégia', 'Garantir o teto e aguardar desempate') + recRow('Risco', 'Contemplação não depende do percentual');
  } else if (prob >= 80) {
    cls = 'ok'; title = 'Lance Muito Forte';
    body = recRow('Seu lance', fmtPct(percInput)) + recRow('Chance histórica', fmt4(prob) + '%') + recRow('Faixa segura', '≥ ' + fmtPct(st.p25)) + recRow('Leitura', 'Muito competitivo');
  } else if (prob >= 50) {
    cls = 'warn'; title = 'Lance Intermediário';
    body = recRow('Seu lance', fmtPct(percInput)) + recRow('Chance histórica', fmt4(prob) + '%') + recRow('Sugestão para melhorar', '≥ ' + fmtPct(st.p75)) + recRow('Leitura', 'Boa chance, mas disputada');
  }
  el('recBox').innerHTML = '<div class="rec ' + cls + '"><h3>' + title + '</h3>' + body + '</div>';

  // ── Gráfico ──
  drawChart(vals, st, percInput, saturated);

  // ── Tabela ──
  el('histBody').innerHTML = EXPORT_DATA.hist.map(r => {
    const d = r.perc - percInput;
    let tag = '', cls = '';
    if (Math.abs(d) < 0.00005) { tag = 'Empatado'; cls = 'tag-eq'; }
    else if (d > 0) { tag = '+' + fmt4(d) + '% maior'; cls = 'tag-up'; }
    else { tag = '-' + fmt4(Math.abs(d)) + '% menor'; cls = 'tag-down'; }
    return '<tr><td>' + formatDateBR(r.data) + '</td><td><b>' + fmtPct(r.perc) + '</b></td>' +
      '<td><span class="tag ' + cls + '">' + tag + '</span></td></tr>';
  }).join('');

  el('resultSection').classList.remove('d-none');
  el('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

}

/* ═══════════════════════════════════════════════════════════════
   ✅ INIT
═══════════════════════════════════════════════════════════════ */

window.addEventListener('DOMContentLoaded', function () {

  // 1. Restaura o intervalo salvo em cache (chips de tempo)
  const savedInterval = localStorage.getItem(CONFIG.INTERVAL_KEY);
  if (savedInterval) {
    document.querySelectorAll('.interval-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.val === savedInterval);
    });
  }

  // 2. Restaura o status do Auto-refresh (Ligado/Desligado)
  const savedRefresh = localStorage.getItem(CONFIG.AUTOREFRESH_KEY);
  if (savedRefresh === '1') {
    el('toggleRefresh').checked = true;
    startAutoRefresh();
  }

  // 3. BUSCA OS DADOS (Aqui estava o seu problema)
  fetchSheet(true);
});