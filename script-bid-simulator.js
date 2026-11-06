/* ═══════════════════════════════════════════════════════════════
   SIMULADOR DE LANCES · MEL CONSÓRCIOS (uso interno)
   A chance é calculada POR ASSEMBLEIA: em cada assembleia, a nota de
   corte é o menor lance contemplado. O lance simulado "venceria" naquela
   assembleia se fosse maior que a nota de corte.
═══════════════════════════════════════════════════════════════ */

/* ── CONFIGURAÇÃO: altere apenas aqui ── */
const CONFIG = {
  // URL pública da planilha (Arquivo › Compartilhar › Publicar na Web › CSV)
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS9g0I4RR_f1O3sKNqQ_K2jdyFU9dmY8t2JdTC3DMG2_UQ5zS9LcR7QNndfmkmsN1mf6Oj0gwYMv0qW/pub?gid=0&single=true&output=csv',

  // Lance embutido (% da carta). Regra geral da Canopus: até 30%.
  // Em modalidades específicas ou promoções pode chegar a 50%: o simulador aceita, com aviso.
  EMBUTIDO_MAX: { padrao: 30 },
  EMBUTIDO_ESPECIAL: 50,

  // Abaixo deste número de assembleias, o simulador avisa que a amostra é pequena
  MIN_ASSEMBLEIAS: 6,

  CACHE_KEY: 'mel_sim_csv',
  CACHE_META_KEY: 'mel_sim_meta',
  PREFS_KEY: 'mel_sim_prefs'
};

const EPS = 0.00005;      // tolerância para considerar dois lances iguais (empate)
const PASSO = 0.0001;     // quanto acima da nota de corte a faixa sugerida fica

/* ═══════════════════════════════════════════════════════════════
   ESTADO
═══════════════════════════════════════════════════════════════ */
const S = {
  rows: [],
  produto: '', grupo: '', tipo: '', periodo: 6,
  chart: null,
  ultimo: null // último cálculo, usado nas exportações
};

/* ═══════════════════════════════════════════════════════════════
   UTILITÁRIOS
═══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function norm(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Converte texto brasileiro ou internacional em número: "83.600,24", "54,1645", "83600.24" */
function parseBR(v) {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim().replace(/[R$\s%]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}

const fmtPct = (v, d = 2) => (v === null || isNaN(v)) ? '—'
  : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
const fmtBRL = v => (v === null || isNaN(v)) ? '—'
  : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtInt = v => Number(v).toLocaleString('pt-BR');

function parseData(str) {
  const s = String(str || '').trim().split(' ')[0];
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], 12);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12);
  return null;
}
const fmtData = d => d ? d.toLocaleDateString('pt-BR') : '—';

function labelProduto(p) { return String(p || '').replace(/^\s*\d+\s*-\s*/, '').trim() || p; }
function labelTipo(t) {
  const n = norm(t);
  const mapa = { 'lance livre': 'Lance Livre', 'lance limitado': 'Lance Limitado', 'lance fixo': 'Lance Fixo', '2o lance fixo': '2º Lance Fixo', 'sorteio': 'Sorteio' };
  return mapa[n] || t;
}
const ehFixo = t => norm(t).includes('fixo');
const ignorado = t => ['sorteio', 'cancelada'].includes(norm(t));

function faixaCreditoTxt(v) {
  const partes = String(v || '').split('-').map(x => parseInt(String(x).replace(/\D/g, ''), 10));
  if (partes.length !== 2 || partes.some(isNaN) || (partes[0] === 0 && partes[1] === 0)) return '—';
  const k = n => n >= 1000000 ? (n / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi' : Math.round(n / 1000) + ' mil';
  return 'R$ ' + k(partes[0]) + ' a ' + k(partes[1]);
}

function embutidoMax(produto) {
  const n = norm(labelProduto(produto));
  return CONFIG.EMBUTIDO_MAX[n] ?? CONFIG.EMBUTIDO_MAX.padrao;
}

function alerta(id, tipo, html) {
  const d = $(id); if (!d) return;
  if (!tipo) { d.className = 'alert d-none'; d.innerHTML = ''; return; }
  d.className = 'alert ' + tipo; d.innerHTML = html;
}

function status(tipo, texto) {
  $('statusDot').className = 'dot ' + tipo;
  $('statusText').textContent = texto;
}

function salvarPrefs() {
  try {
    localStorage.setItem(CONFIG.PREFS_KEY, JSON.stringify({
      produto: S.produto, grupo: S.grupo, tipo: S.tipo, periodo: S.periodo, embutido: $('inpEmbutido').value
    }));
  } catch (e) { /* armazenamento indisponível */ }
}
function lerPrefs() {
  try { return JSON.parse(localStorage.getItem(CONFIG.PREFS_KEY) || '{}'); } catch (e) { return {}; }
}

/* ═══════════════════════════════════════════════════════════════
   LEITURA DA PLANILHA
═══════════════════════════════════════════════════════════════ */
function parseCSV(text) {
  // Leitor completo: aceita aspas, vírgulas e quebras de linha dentro de campos
  const linhas = []; let campo = '', linha = [], aspas = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (aspas) {
      if (c === '"') { if (text[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      linha.push(campo); linhas.push(linha); linha = []; campo = '';
    } else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }

  const validas = linhas.filter(l => l.some(x => x.trim()));
  if (!validas.length) throw new Error('A planilha está vazia.');
  const cab = validas[0].map(h => h.trim());
  const obrig = ['tipoLance', 'dataContemplacao', 'grupo', 'produto', 'percLance'];
  const faltam = obrig.filter(c => !cab.includes(c));
  if (faltam.length) throw new Error('Colunas ausentes na planilha: ' + faltam.join(', '));
  const idx = Object.fromEntries(cab.map((h, i) => [h, i]));

  const rows = [];
  for (let i = 1; i < validas.length; i++) {
    const l = validas[i];
    const get = c => (idx[c] !== undefined ? (l[idx[c]] || '').trim() : '');
    let grupo = get('grupo'); if (grupo.endsWith('.0')) grupo = grupo.slice(0, -2);
    const produto = get('produto'), tipo = get('tipoLance'), perc = parseBR(get('percLance'));
    const data = parseData(get('dataContemplacao'));
    if (!grupo || !produto || !tipo || isNaN(perc) || !data) continue;
    rows.push({
      grupo, produto, tipo, perc, data,
      dataKey: data.toISOString().slice(0, 10),
      assembleiaAtual: get('assembleiaAtual'),
      assembleiaRealizar: get('assembleiaRealizar'),
      faixaCredito: get('faixaCredito')
    });
  }
  if (!rows.length) throw new Error('Nenhum registro válido encontrado. Confira as colunas e as datas.');
  return rows;
}

async function carregarPlanilha(manual) {
  status('load', 'Buscando dados da planilha…');
  $('btnRefresh').disabled = true;
  try {
    const url = CONFIG.SHEET_URL + (CONFIG.SHEET_URL.includes('?') ? '&' : '?') + '_=' + Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + '. Confira se a planilha está publicada como CSV.');
    const txt = await res.text();
    aplicarDados(parseCSV(txt));
    const agora = new Date().toLocaleString('pt-BR');
    try {
      localStorage.setItem(CONFIG.CACHE_KEY, txt);
      localStorage.setItem(CONFIG.CACHE_META_KEY, agora);
    } catch (e) { /* cache indisponível */ }
    status('ok', resumoDados('atualizado ' + agora));
    alerta('alertLoad', manual ? 'ok' : '', manual ? 'Dados atualizados: <b>' + fmtInt(S.rows.length) + '</b> registros.' : '');
  } catch (err) {
    let cache = null, meta = '';
    try { cache = localStorage.getItem(CONFIG.CACHE_KEY); meta = localStorage.getItem(CONFIG.CACHE_META_KEY) || ''; } catch (e) { /* sem cache */ }
    if (cache) {
      try {
        aplicarDados(parseCSV(cache));
        status('err', resumoDados('cópia salva de ' + meta));
        alerta('alertLoad', 'warn', 'Não foi possível buscar a planilha agora (' + esc(err.message) + '). Usando a última cópia salva, de <b>' + esc(meta) + '</b>.');
      } catch (e2) {
        status('err', 'Erro ao carregar'); alerta('alertLoad', 'err', '<b>Erro ao ler a planilha:</b> ' + esc(err.message));
      }
    } else {
      status('err', 'Erro ao carregar');
      alerta('alertLoad', 'err', '<b>Não foi possível carregar a planilha:</b> ' + esc(err.message));
    }
  } finally {
    $('btnRefresh').disabled = false;
  }
}

function resumoDados(extra) {
  const ultima = S.rows.reduce((m, r) => (r.data > m ? r.data : m), new Date(0));
  return fmtInt(S.rows.length) + ' registros · assembleias até ' + fmtData(ultima) + ' · ' + extra;
}

function aplicarDados(rows) {
  S.rows = rows;
  const prefs = lerPrefs();
  const produtos = listaProdutos();
  if (!produtos.includes(S.produto)) S.produto = produtos.includes(prefs.produto) ? prefs.produto : produtos[0];
  if (!S.tipo && prefs.tipo) S.tipo = prefs.tipo;
  if (!S.grupo && prefs.grupo) S.grupo = prefs.grupo;
  if (prefs.periodo !== undefined && !aplicarDados.prefsAplicadas) {
    S.periodo = Number(prefs.periodo); $('selPeriodo').value = String(S.periodo);
    if (prefs.embutido !== undefined) $('inpEmbutido').value = prefs.embutido;
    aplicarDados.prefsAplicadas = true;
  }
  renderProdutos();
  selecionarProduto(S.produto, true);
}

/* ═══════════════════════════════════════════════════════════════
   LISTAS
═══════════════════════════════════════════════════════════════ */
function listaProdutos() {
  return [...new Set(S.rows.map(r => r.produto))].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
}
function listaTipos(produto) {
  const tipos = [...new Set(S.rows.filter(r => r.produto === produto && !ignorado(r.tipo)).map(r => r.tipo))];
  const ordem = ['lance livre', 'lance limitado', 'lance fixo', '2o lance fixo'];
  return tipos.sort((a, b) => (ordem.indexOf(norm(a)) + 99) % 99 - (ordem.indexOf(norm(b)) + 99) % 99 || a.localeCompare(b));
}
function listaGrupos(produto, tipo) {
  const mapa = {};
  S.rows.filter(r => r.produto === produto).forEach(r => {
    const g = mapa[r.grupo] || (mapa[r.grupo] = { grupo: r.grupo, temTipo: false, ultima: null });
    if (r.tipo === tipo) g.temTipo = true;
    if (!g.ultima || r.data > g.ultima.data) g.ultima = r; // dados do grupo vêm da assembleia MAIS RECENTE
  });
  return Object.values(mapa).filter(g => g.temTipo).sort((a, b) => a.grupo.localeCompare(b.grupo, undefined, { numeric: true }));
}

/** Assembleias de um grupo/tipo, da mais antiga para a mais recente, já cortadas pelo período */
function assembleias(produto, grupo, tipo, periodo) {
  const porData = {};
  S.rows.forEach(r => {
    if (r.produto !== produto || r.grupo !== grupo || r.tipo !== tipo) return;
    (porData[r.dataKey] || (porData[r.dataKey] = { data: r.data, lances: [] })).lances.push(r.perc);
  });
  let lista = Object.values(porData).sort((a, b) => a.data - b.data).map(a => {
    const l = a.lances.slice().sort((x, y) => x - y);
    return { data: a.data, n: l.length, corte: l[0], maior: l[l.length - 1], lances: l };
  });
  if (periodo > 0) lista = lista.slice(-periodo);
  return lista;
}

/* ═══════════════════════════════════════════════════════════════
   CÁLCULOS
═══════════════════════════════════════════════════════════════ */
function chance(lista, lance) {
  let vence = 0, empata = 0;
  lista.forEach(a => {
    if (lance > a.corte + EPS) vence++;
    else if (Math.abs(lance - a.corte) <= EPS) empata++;
  });
  const n = lista.length;
  return { n, vence, empata, perde: n - vence - empata, pct: n ? vence / n * 100 : 0 };
}

function mediana(arr) {
  const s = arr.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
}

/** Lance mínimo que teria vencido em pelo menos p% das assembleias */
function faixa(lista, p) {
  const cortes = lista.map(a => a.corte).sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(p * cortes.length));
  return cortes[k - 1] + PASSO;
}

function noTeto(lista) {
  if (lista.length < 2) return false;
  const cortes = lista.map(a => a.corte);
  return Math.max(...cortes) - Math.min(...cortes) < EPS && lista.every(a => a.maior - a.corte < EPS);
}

function composicao(carta, lance, embutidoPct) {
  const emb = Math.max(0, Math.min(embutidoPct, lance));
  const bolsoPct = Math.max(0, lance - emb);
  if (!(carta > 0)) return { emb, bolsoPct, total: NaN, embR: NaN, bolsoR: NaN, pega: NaN };
  return {
    emb, bolsoPct,
    total: carta * lance / 100,
    embR: carta * emb / 100,
    bolsoR: carta * bolsoPct / 100,
    pega: carta - carta * emb / 100
  };
}

function classe(pct) {
  if (pct >= 80) return { b: 'b-ok', t: 'Chance alta', cor: '#15803d', txt: 'O lance teria sido contemplado na grande maioria das assembleias do período.' };
  if (pct >= 50) return { b: 'b-warn', t: 'Chance intermediária', cor: '#a16207', txt: 'O lance é competitivo, mas teria ficado de fora em parte das assembleias.' };
  return { b: 'b-bad', t: 'Chance baixa', cor: '#b91c1c', txt: 'O lance ficou abaixo da nota de corte na maior parte das assembleias.' };
}

/* ═══════════════════════════════════════════════════════════════
   SELEÇÃO
═══════════════════════════════════════════════════════════════ */
function renderProdutos() {
  const prods = listaProdutos();
  $('produtoGrid').innerHTML = prods.map(p =>
    '<button type="button" class="chip" data-produto="' + esc(p) + '" aria-pressed="' + (p === S.produto) + '">' + esc(labelProduto(p)) + '</button>'
  ).join('') || '<span class="placeholder">Nenhum produto na planilha</span>';
}

function selecionarProduto(p, manterSelecao) {
  S.produto = p;
  document.querySelectorAll('#produtoGrid .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.produto === p)));
  const tipos = listaTipos(p);
  if (!manterSelecao || !tipos.includes(S.tipo)) S.tipo = tipos.find(t => norm(t) === 'lance livre') || tipos[0] || '';
  $('selTipo').innerHTML = tipos.map(t => '<option value="' + esc(t) + '"' + (t === S.tipo ? ' selected' : '') + '>' + esc(labelTipo(t)) + '</option>').join('')
    || '<option value="">Sem lances para este produto</option>';
  const max = embutidoMax(p);
  $('embutidoMaxTxt').textContent = '(padrão até ' + fmtPct(max, 0) + ', especial até ' + fmtPct(CONFIG.EMBUTIDO_ESPECIAL, 0) + ')';
  renderGrupos(manterSelecao);
}

function renderGrupos(manterSelecao) {
  const grupos = listaGrupos(S.produto, S.tipo);
  if (!grupos.length) {
    $('grupoGrid').innerHTML = '<span class="placeholder">Nenhum grupo com este tipo de lance</span>';
    S.grupo = ''; calcular(); return;
  }
  if (!manterSelecao || !grupos.some(g => g.grupo === S.grupo)) S.grupo = grupos[0].grupo;
  $('grupoGrid').innerHTML = grupos.map(g => {
    const u = g.ultima;
    const atual = parseInt(u.assembleiaAtual, 10), rest = parseInt(u.assembleiaRealizar, 10);
    const det = [
      isNaN(atual) ? null : 'Assembleia ' + atual,
      isNaN(rest) ? null : 'faltam ' + rest,
      faixaCreditoTxt(u.faixaCredito) !== '—' ? faixaCreditoTxt(u.faixaCredito) : null
    ].filter(Boolean).join(' · ');
    return '<button type="button" class="chip" data-grupo="' + esc(g.grupo) + '" aria-pressed="' + (g.grupo === S.grupo) + '">Grupo ' + esc(g.grupo) +
      (det ? '<small>' + esc(det) + '</small>' : '') + '</button>';
  }).join('');
  calcular();
}

function selecionarGrupo(g) {
  S.grupo = g;
  document.querySelectorAll('#grupoGrid .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.grupo === g)));
  calcular();
}

/* ═══════════════════════════════════════════════════════════════
   CÁLCULO E TELA
═══════════════════════════════════════════════════════════════ */
function lerEntradas() {
  const carta = parseBR($('inpCarta').value);
  const percTxt = $('inpPerc').value.trim();
  const perc = parseBR(percTxt);
  const max = embutidoMax(S.produto), especial = CONFIG.EMBUTIDO_ESPECIAL;
  let emb = parseBR($('inpEmbutido').value);
  if (isNaN(emb) || emb < 0) emb = 0;
  const embAjustado = Math.min(emb, especial);

  $('inpCarta').classList.toggle('invalid', $('inpCarta').value.trim() !== '' && !(carta > 0));
  $('inpPerc').classList.toggle('invalid', percTxt !== '' && (isNaN(perc) || perc <= 0 || perc > 100));
  $('inpEmbutido').classList.toggle('invalid', emb > especial);

  return { carta: carta > 0 ? carta : NaN, perc: (percTxt && perc > 0 && perc <= 100) ? perc : NaN, emb: embAjustado,
    embEspecial: emb > max && emb <= especial, embAcima: emb > especial, max, especial };
}

function calcular() {
  salvarPrefs();
  if (!S.produto || !S.grupo || !S.tipo) { $('results').classList.add('d-none'); return; }

  const lista = assembleias(S.produto, S.grupo, S.tipo, S.periodo);
  if (!lista.length) {
    alerta('alertCalc', 'err', 'Nenhuma assembleia com este tipo de lance no período escolhido.');
    $('results').classList.add('d-none'); return;
  }
  const ent = lerEntradas();
  const avisos = [];
  const maisRecente = S.rows.reduce((m, r) => (r.data > m ? r.data : m), new Date(0));
  const ultimaDoGrupo = lista[lista.length - 1].data;
  if ((maisRecente - ultimaDoGrupo) / 864e5 > 45) {
    avisos.push('Este grupo não tem assembleia registrada desde <b>' + fmtData(ultimaDoGrupo) + '</b>. A planilha vai até ' + fmtData(maisRecente) + '. Confira se o grupo ainda está ativo.');
  }
  if (ent.embAcima) avisos.push('O lance embutido foi limitado a <b>' + fmtPct(ent.especial, 0) + '</b> da carta, o máximo em modalidades especiais.');
  if (ent.embEspecial) avisos.push('Embutido acima de <b>' + fmtPct(ent.max, 0) + '</b> só vale em modalidades específicas ou promoções da Canopus. Confirme antes de apresentar ao cliente.');

  if (ehFixo(S.tipo)) { telaFixo(lista, ent, avisos); return; }

  const teto = noTeto(lista);
  const faixas = [
    { nome: 'Conservador', p: .5, valor: faixa(lista, .5) },
    { nome: 'Moderado', p: .75, valor: faixa(lista, .75) },
    { nome: 'Forte', p: .9, valor: faixa(lista, .9) }
  ];
  const sugerido = isNaN(ent.perc);
  const lance = sugerido ? (teto ? lista[0].corte : faixas[1].valor) : ent.perc;
  const ch = chance(lista, lance);
  const comp = composicao(ent.carta, lance, ent.emb);

  if (lista.length < CONFIG.MIN_ASSEMBLEIAS) avisos.push('Amostra pequena: só <b>' + lista.length + '</b> assembleia(s) no período. Use o resultado com cautela.');
  if (sugerido) avisos.push('Sem lance digitado: usando a faixa <b>moderada</b> (' + fmtPct(lance, 4) + ').');
  alerta('alertCalc', avisos.length ? 'warn' : '', avisos.join('<br>'));

  // ── Cartão principal
  const c = teto ? { b: 'b-neu', t: 'Grupo no teto', cor: '#475569', txt: 'Todas as assembleias do período foram decididas no mesmo percentual. Quem oferta o teto disputa por desempate.' } : classe(ch.pct);
  const valorGauge = teto ? '—' : Math.round(ch.pct) + '%';
  const angulo = teto ? 0 : ch.pct * 3.6;
  const empTxt = ch.empata ? ', empataria em <b>' + ch.empata + '</b>' : '';
  const ultima = lista[lista.length - 1];

  $('cardResult').innerHTML =
    '<div class="gauge" style="background:conic-gradient(' + c.cor + ' ' + angulo + 'deg,#e2e8f0 0)">' +
      '<div class="gauge-inner"><span class="gauge-v" style="color:' + c.cor + '">' + valorGauge + '</span><span class="gauge-l">' + (teto ? 'teto' : 'chance') + '</span></div>' +
    '</div>' +
    '<div class="res-body">' +
      '<span class="badge ' + c.b + '">' + esc(labelTipo(S.tipo)) + ' · Grupo ' + esc(S.grupo) + '</span>' +
      '<h2 class="res-title">' + c.t + '</h2>' +
      '<p class="res-text">' + c.txt + '</p>' +
      '<div class="res-meta">Com <b>' + fmtPct(lance, 4) + '</b>, o lance teria vencido em <b>' + ch.vence + ' de ' + ch.n + '</b> assembleias' + empTxt + '. ' +
      'Período: <b>' + fmtData(lista[0].data) + '</b> a <b>' + fmtData(ultima.data) + '</b> · última nota de corte: <b>' + fmtPct(ultima.corte, 4) + '</b> · corte mediano: <b>' + fmtPct(mediana(lista.map(a => a.corte)), 4) + '</b></div>' +
      blocoComposicao(comp, lance) +
    '</div>';

  // ── Faixas
  $('faixas').parentElement.classList.remove('d-none');
  $('faixas').innerHTML = faixas.map((f, i) => {
    const cf = composicao(ent.carta, f.valor, ent.emb);
    const chf = chance(lista, f.valor);
    return '<div class="faixa' + (i === 2 ? ' forte' : '') + '">' +
      '<h3>' + f.nome + '<span>venceria em ' + chf.vence + ' de ' + chf.n + '</span></h3>' +
      '<div class="pct">' + fmtPct(f.valor, 4) + '</div>' +
      '<dl>' +
        '<dt>Lance total</dt><dd>' + fmtBRL(cf.total) + '</dd>' +
        '<dt>Embutido (' + fmtPct(cf.emb, 2) + ')</dt><dd>' + fmtBRL(cf.embR) + '</dd>' +
        '<dt>Do bolso (' + fmtPct(cf.bolsoPct, 2) + ')</dt><dd>' + fmtBRL(cf.bolsoR) + '</dd>' +
      '</dl>' +
      '<button type="button" class="btn btn-gold btn-sm" data-usar="' + f.valor.toFixed(4) + '">Usar este lance</button>' +
    '</div>';
  }).join('');

  desenharGrafico(lista, lance, false);
  tabelaHistorico(lista, lance, false);
  tabelaComparar(lance, false);

  S.ultimo = { lista, lance, ch, comp, faixas, teto, fixo: false, ent };
  $('results').classList.remove('d-none');
}

function blocoComposicao(comp, lance) {
  if (isNaN(comp.total)) {
    return '<div class="breakdown"><div class="bk"><div class="k">Lance total</div><div class="v">' + fmtPct(lance, 4) + '</div><div class="s">Informe o valor da carta para ver em R$</div></div>' +
      '<div class="bk"><div class="k">Embutido</div><div class="v">' + fmtPct(comp.emb, 2) + '</div></div>' +
      '<div class="bk"><div class="k">Do bolso</div><div class="v">' + fmtPct(comp.bolsoPct, 2) + '</div></div>' +
      '<div class="bk hl"><div class="k">Cliente recebe</div><div class="v">' + fmtPct(100 - comp.emb, 2) + '</div><div class="s">da carta</div></div></div>';
  }
  return '<div class="breakdown">' +
    '<div class="bk"><div class="k">Lance total</div><div class="v">' + fmtBRL(comp.total) + '</div><div class="s">' + fmtPct(lance, 4) + '</div></div>' +
    '<div class="bk"><div class="k">Embutido</div><div class="v">' + fmtBRL(comp.embR) + '</div><div class="s">' + fmtPct(comp.emb, 4) + ' da carta</div></div>' +
    '<div class="bk"><div class="k">Do bolso</div><div class="v">' + fmtBRL(comp.bolsoR) + '</div><div class="s">' + fmtPct(comp.bolsoPct, 4) + '</div></div>' +
    '<div class="bk hl"><div class="k">Cliente recebe</div><div class="v">' + fmtBRL(comp.pega) + '</div><div class="s">crédito líquido</div></div>' +
  '</div>';
}

function telaFixo(lista, ent, avisos) {
  const perc = mediana(lista.flatMap(a => a.lances));
  const media = lista.reduce((s, a) => s + a.n, 0) / lista.length;
  const comp = composicao(ent.carta, perc, ent.emb);
  if (lista.length < CONFIG.MIN_ASSEMBLEIAS) avisos.push('Amostra pequena: só <b>' + lista.length + '</b> assembleia(s) no período.');
  alerta('alertCalc', avisos.length ? 'warn' : '', avisos.join('<br>'));

  $('cardResult').innerHTML =
    '<div class="gauge" style="background:#e2e8f0"><div class="gauge-inner"><span class="gauge-v" style="color:#173f66">' + media.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '</span><span class="gauge-l">por assembleia</span></div></div>' +
    '<div class="res-body">' +
      '<span class="badge b-neu">' + esc(labelTipo(S.tipo)) + ' · Grupo ' + esc(S.grupo) + '</span>' +
      '<h2 class="res-title">' + esc(labelTipo(S.tipo)) + ' de ' + fmtPct(perc, 2) + '</h2>' +
      '<p class="res-text">No lance fixo o percentual é o mesmo para todos, então não existe nota de corte. A contemplação é decidida por desempate entre quem ofertou. Em média, <b>' + media.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '</b> cota(s) foram contempladas por assembleia neste tipo.</p>' +
      '<div class="res-meta">Período: <b>' + fmtData(lista[0].data) + '</b> a <b>' + fmtData(lista[lista.length - 1].data) + '</b> · ' + lista.length + ' assembleias</div>' +
      blocoComposicao(comp, perc) +
    '</div>';

  $('faixas').parentElement.classList.add('d-none');
  desenharGrafico(lista, perc, true);
  tabelaHistorico(lista, perc, true);
  tabelaComparar(perc, true);
  S.ultimo = { lista, lance: perc, ch: null, comp, faixas: [], teto: false, fixo: true, media, ent };
  $('results').classList.remove('d-none');
}

function desenharGrafico(lista, lance, fixo) {
  if (typeof Chart === 'undefined') { setTimeout(() => desenharGrafico(lista, lance, fixo), 300); return; }
  if (S.chart) { S.chart.destroy(); S.chart = null; }
  const labels = lista.map(a => fmtData(a.data).slice(0, 5) + '/' + String(a.data.getFullYear()).slice(2));
  const ds = fixo
    ? [{ type: 'bar', label: 'Contemplados', data: lista.map(a => a.n), backgroundColor: 'rgba(23,63,102,.75)', borderRadius: 6 }]
    : [
        { label: 'Nota de corte', data: lista.map(a => +a.corte.toFixed(4)), borderColor: '#0a1c36', backgroundColor: 'rgba(10,28,54,.08)', fill: true, tension: .25, pointRadius: 4, pointBackgroundColor: '#0a1c36' },
        { label: 'Maior lance', data: lista.map(a => +a.maior.toFixed(4)), borderColor: '#94a3b8', borderDash: [4, 4], pointRadius: 0, tension: .25, fill: false },
        { label: 'Lance simulado', data: lista.map(() => +lance.toFixed(4)), borderColor: '#c6a55c', borderWidth: 2.5, pointRadius: 0, fill: false }
      ];
  S.chart = new Chart($('chart'), {
    type: fixo ? 'bar' : 'line',
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !fixo, labels: { boxWidth: 12, font: { family: 'Inter' } } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (fixo ? ctx.parsed.y : fmtPct(ctx.parsed.y, 4)) } }
      },
      scales: {
        x: { grid: { display: false } },
        y: fixo ? { beginAtZero: true, ticks: { stepSize: 1 } } : { ticks: { callback: v => fmtPct(v, 0) } }
      }
    }
  });
}

function tabelaHistorico(lista, lance, fixo) {
  $('tblHist').querySelector('tbody').innerHTML = lista.slice().reverse().map(a => {
    let tag;
    if (fixo) tag = '<span class="tag t-neu">Desempate entre ' + a.n + ' cota(s)</span>';
    else if (lance > a.corte + EPS) tag = '<span class="tag t-ok">Contemplado (+' + fmtPct(lance - a.corte, 4) + ')</span>';
    else if (Math.abs(lance - a.corte) <= EPS) tag = '<span class="tag t-eq">Empate na nota de corte</span>';
    else tag = '<span class="tag t-bad">Ficaria de fora (−' + fmtPct(a.corte - lance, 4) + ')</span>';
    return '<tr><td>' + fmtData(a.data) + '</td><td class="r">' + a.n + '</td><td class="r">' + fmtPct(a.corte, 4) + '</td><td class="r">' + fmtPct(a.maior, 4) + '</td><td>' + tag + '</td></tr>';
  }).join('');
}

function tabelaComparar(lance, fixo) {
  const grupos = listaGrupos(S.produto, S.tipo);
  const thead = $('tblComparar').querySelectorAll('th');
  thead[1].textContent = fixo ? 'Média/assembleia' : 'Chance';
  thead[2].textContent = fixo ? '% do lance' : 'Corte mediano';
  thead[3].textContent = fixo ? 'Última assembleia' : 'Último corte';

  const linhas = grupos.map(g => {
    const l = assembleias(S.produto, g.grupo, S.tipo, S.periodo);
    if (!l.length) return null;
    const u = g.ultima;
    const rest = parseInt(u.assembleiaRealizar, 10);
    if (fixo) {
      const media = l.reduce((s, a) => s + a.n, 0) / l.length;
      return { g: g.grupo, ordem: media, c1: media.toLocaleString('pt-BR', { maximumFractionDigits: 1 }), c2: fmtPct(mediana(l.flatMap(a => a.lances)), 2), c3: String(l[l.length - 1].n), n: l.length, cred: faixaCreditoTxt(u.faixaCredito), rest };
    }
    const ch = chance(l, lance);
    return { g: g.grupo, ordem: ch.pct, c1: Math.round(ch.pct) + '%' + (ch.empata ? ' <small class="hint">(+' + ch.empata + ' emp.)</small>' : ''), c2: fmtPct(mediana(l.map(a => a.corte)), 2), c3: fmtPct(l[l.length - 1].corte, 2), n: l.length, cred: faixaCreditoTxt(u.faixaCredito), rest, pct: ch.pct };
  }).filter(Boolean).sort((a, b) => b.ordem - a.ordem);

  $('compararInfo').textContent = fixo ? 'Ordenado pela média de contemplados' : 'Ordenado pela chance com ' + fmtPct(lance, 4);
  $('tblComparar').querySelector('tbody').innerHTML = linhas.map(x => {
    const sit = fixo ? '' : (x.pct >= 80 ? '<span class="tag t-ok">Alta</span>' : x.pct >= 50 ? '<span class="tag t-eq">Média</span>' : '<span class="tag t-bad">Baixa</span>');
    const amostra = x.n < CONFIG.MIN_ASSEMBLEIAS ? ' <span class="tag t-neu">amostra pequena</span>' : '';
    return '<tr class="clicavel' + (x.g === S.grupo ? ' atual' : '') + '" data-grupo="' + esc(x.g) + '" tabindex="0">' +
      '<td><b>Grupo ' + esc(x.g) + '</b>' + (isNaN(x.rest) ? '' : '<br><small class="hint">faltam ' + x.rest + ' assembleias</small>') + '</td>' +
      '<td class="r"><b>' + x.c1 + '</b></td><td class="r">' + x.c2 + '</td><td class="r">' + x.c3 + '</td><td class="r">' + x.n + '</td>' +
      '<td>' + esc(x.cred) + '</td><td>' + sit + amostra + '</td></tr>';
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════
   EXPORTAÇÕES
═══════════════════════════════════════════════════════════════ */
function baixar(nome, conteudo, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportarCSV() {
  const u = S.ultimo; if (!u) return;
  const linhas = [['Assembleia', 'Produto', 'Grupo', 'Tipo de lance', 'Contemplados', 'Nota de corte (%)', 'Maior lance (%)', 'Lance simulado (%)', 'Resultado']];
  u.lista.forEach(a => {
    const res = u.fixo ? 'Desempate' : (u.lance > a.corte + EPS ? 'Contemplado' : Math.abs(u.lance - a.corte) <= EPS ? 'Empate' : 'Ficaria de fora');
    linhas.push([fmtData(a.data), labelProduto(S.produto), S.grupo, labelTipo(S.tipo), a.n, a.corte.toFixed(4).replace('.', ','), a.maior.toFixed(4).replace('.', ','), u.lance.toFixed(4).replace('.', ','), res]);
  });
  const csv = '﻿' + linhas.map(l => l.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\n');
  baixar('Historico_Grupo_' + S.grupo + '.csv', csv, 'text/csv;charset=utf-8');
}

let pdfLib = null;
function carregarScript(src) {
  return new Promise((ok, erro) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = erro; document.head.appendChild(s); });
}
async function exportarPDF() {
  const u = S.ultimo; if (!u) return;
  const btn = $('btnPDF'); btn.disabled = true; btn.textContent = 'Gerando…';
  try {
    if (!pdfLib) {
      await carregarScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
      await carregarScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
      pdfLib = window.jspdf;
    }
    const doc = new pdfLib.jsPDF();
    const navy = [10, 28, 54], gold = [198, 165, 92], cinza = [100, 116, 139];
    doc.setFillColor(...navy); doc.rect(0, 0, 210, 28, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('Mel Consórcios · Simulação de Lance', 14, 13);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text(labelProduto(S.produto) + ' · Grupo ' + S.grupo + ' · ' + labelTipo(S.tipo) + ' · Canopus', 14, 21);

    doc.setTextColor(...navy); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    let y = 40;
    if (u.fixo) {
      doc.text(labelTipo(S.tipo) + ' de ' + fmtPct(u.lance, 2) + ' · média de ' + u.media.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' contemplado(s) por assembleia', 14, y);
    } else {
      doc.text('Lance simulado: ' + fmtPct(u.lance, 4) + (u.teto ? ' · grupo no teto' : ' · venceria em ' + u.ch.vence + ' de ' + u.ch.n + ' assembleias (' + Math.round(u.ch.pct) + '%)'), 14, y);
    }
    y += 8;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...cinza);
    doc.text('Período: ' + fmtData(u.lista[0].data) + ' a ' + fmtData(u.lista[u.lista.length - 1].data) + ' · ' + u.lista.length + ' assembleias', 14, y);
    if (!isNaN(u.comp.total)) {
      y += 6;
      doc.text('Carta: ' + fmtBRL(u.ent.carta) + ' · Lance: ' + fmtBRL(u.comp.total) + ' · Embutido: ' + fmtBRL(u.comp.embR) + ' · Do bolso: ' + fmtBRL(u.comp.bolsoR) + ' · Cliente recebe: ' + fmtBRL(u.comp.pega), 14, y);
    }
    y += 6;

    if (u.faixas.length) {
      doc.autoTable({
        startY: y + 2,
        head: [['Faixa', 'Lance (%)', 'Venceria em', 'Lance total', 'Do bolso']],
        body: u.faixas.map(f => {
          const cf = composicao(u.ent.carta, f.valor, u.ent.emb), chf = chance(u.lista, f.valor);
          return [f.nome, fmtPct(f.valor, 4), chf.vence + ' de ' + chf.n, fmtBRL(cf.total), fmtBRL(cf.bolsoR)];
        }),
        theme: 'grid', headStyles: { fillColor: gold, textColor: navy }, bodyStyles: { fontSize: 9.5 }
      });
      y = doc.lastAutoTable.finalY + 6;
    }

    doc.autoTable({
      startY: y,
      head: [['Assembleia', 'Contemplados', 'Nota de corte', 'Maior lance', 'Com o lance simulado']],
      body: u.lista.slice().reverse().map(a => [
        fmtData(a.data), String(a.n), fmtPct(a.corte, 4), fmtPct(a.maior, 4),
        u.fixo ? 'Desempate' : (u.lance > a.corte + EPS ? 'Contemplado' : Math.abs(u.lance - a.corte) <= EPS ? 'Empate' : 'Ficaria de fora')
      ]),
      theme: 'grid', headStyles: { fillColor: navy }, bodyStyles: { fontSize: 9.5 }, alternateRowStyles: { fillColor: [248, 250, 252] }
    });

    const h = doc.internal.pageSize.getHeight();
    doc.setFontSize(8); doc.setTextColor(...cinza);
    doc.text('Estimativa baseada no histórico de assembleias. Resultados passados não garantem contemplação futura. Gerado em ' + new Date().toLocaleString('pt-BR') + '.', 14, h - 10);
    doc.save('Simulacao_Grupo_' + S.grupo + '.pdf');
  } catch (e) {
    alerta('alertLoad', 'err', 'Não foi possível gerar o PDF. Confira a conexão e tente de novo.');
  } finally {
    btn.disabled = false; btn.textContent = '📄 PDF';
  }
}

/* ═══════════════════════════════════════════════════════════════
   EVENTOS
═══════════════════════════════════════════════════════════════ */
let timer = null;
const recalcular = () => { clearTimeout(timer); timer = setTimeout(calcular, 250); };

document.addEventListener('click', e => {
  const p = e.target.closest('[data-produto]'); if (p) { selecionarProduto(p.dataset.produto, false); return; }
  const g = e.target.closest('#grupoGrid [data-grupo]'); if (g) { selecionarGrupo(g.dataset.grupo); return; }
  const linha = e.target.closest('#tblComparar tr[data-grupo]');
  if (linha) {
    selecionarGrupo(linha.dataset.grupo);
    document.querySelector('#grupoGrid [aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const usar = e.target.closest('[data-usar]');
  if (usar) { $('inpPerc').value = Number(usar.dataset.usar).toFixed(4).replace('.', ','); calcular(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('#tblComparar tr[data-grupo]')) selecionarGrupo(e.target.dataset.grupo);
});

$('selTipo').addEventListener('change', e => { S.tipo = e.target.value; renderGrupos(true); });
$('selPeriodo').addEventListener('change', e => { S.periodo = Number(e.target.value); calcular(); });
['inpCarta', 'inpPerc', 'inpEmbutido'].forEach(id => $(id).addEventListener('input', recalcular));
$('inpCarta').addEventListener('blur', e => {
  const v = parseBR(e.target.value);
  if (v > 0) e.target.value = v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});
$('btnRefresh').addEventListener('click', () => carregarPlanilha(true));
$('btnCSV').addEventListener('click', exportarCSV);
$('btnPDF').addEventListener('click', exportarPDF);

/* ── INÍCIO ── */
carregarPlanilha(false);
