import {
  Match,
  MatchRules,
  Session,
  SessionRules,
  LiveDraw,
  State,
  EndReason,
  DrawPolicy,
  normalize,
} from './core.js';

/* ====================================================================
 * Organiza Rachão. Sem conta, sem servidor: tudo fica no aparelho.
 * ==================================================================== */

const KEY_V1 = 'pelada.v1';
const KEY = 'pelada.v2';
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const HISTORY_MAX = 30;
const NAME_MAX = 40;
const clock = () => Date.now();

const PALETTE = [
  { id: 'azul', name: 'Azul', hex: '#1f5fd6', text: '#ffffff' },
  { id: 'vermelho', name: 'Vermelho', hex: '#d62d2d', text: '#ffffff' },
  { id: 'amarelo', name: 'Amarelo', hex: '#f4c20d', text: '#111111' },
  { id: 'verde', name: 'Verde', hex: '#177d3b', text: '#ffffff' },
  { id: 'preto', name: 'Preto', hex: '#161616', text: '#ffffff' },
  { id: 'branco', name: 'Branco', hex: '#f4f4f0', text: '#111111' },
  { id: 'laranja', name: 'Laranja', hex: '#f07a12', text: '#111111' },
  { id: 'roxo', name: 'Roxo', hex: '#7a3cc4', text: '#ffffff' },
];
const paletteById = (id) => PALETTE.find((c) => c.id === id) || PALETTE[0];

const LIMITS = {
  teams: [2, 6],
  perTeam: [3, 11],
  headcount: [4, 66],
  minutes: [0, 60],
  goals: [0, 15],
  streak: [0, 9],
};

const DRAW_LABELS = {
  [DrawPolicy.AUTO]: 'Automático',
  [DrawPolicy.BOTH_LEAVE]: 'Saem os dois',
  [DrawPolicy.CHALLENGER_STAYS]: 'Fica quem estava entrando',
};

const REASON_LABELS = {
  [EndReason.TIME]: 'Acabou o tempo',
  [EndReason.GOALS]: 'Limite de gols',
  [EndReason.MANUAL]: 'Encerrada à mão',
};

const defaultConfig = () => ({
  mode: 'names',
  teams: 3,
  perTeam: 7,
  headcount: 20,
  minutes: 10,
  goals: 2,
  streak: 2,
  draw: DrawPolicy.AUTO,
  sound: true,
  colors: PALETTE.map((c) => c.id),
  present: [],
});

/* ---------------------------------------------------------------- utilidades */

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad2 = (n) => String(n).padStart(2, '0');
const mmss = (secs) => `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`;
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const ICONS = {
};

/* ---------------------------------------------------------------- armazenamento */

const store = {
  read(key = KEY) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  write(value) {
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

function hydrate(o) {
  if (!o) return null;
  const session = Session.fromJSON(o.session);
  return {
    ...o,
    session,
    draw: LiveDraw.fromJSON(o.draw),
    match: o.match ? Match.fromJSON(o.match, session.rules.match, clock) : null,
  };
}

function dehydrate(r) {
  if (!r) return null;
  return { ...r, session: r.session.toJSON(), draw: r.draw.toJSON(), match: r.match ? r.match.toJSON() : null };
}

function cleanGroup(saved, fallbackName) {
  saved = saved || {};
  const config = { ...defaultConfig(), ...(saved.config || {}) };
  const ids = PALETTE.map((c) => c.id);
  const okColors =
    Array.isArray(config.colors) && config.colors.length === ids.length && ids.every((i) => config.colors.includes(i));
  if (!okColors) config.colors = defaultConfig().colors;
  for (const k of Object.keys(LIMITS)) config[k] = clamp(Number(config[k]) || 0, LIMITS[k][0], LIMITS[k][1]);
  if (!Object.values(DrawPolicy).includes(config.draw)) config.draw = DrawPolicy.AUTO;
  if (!Array.isArray(config.present)) config.present = [];
  let run = null;
  try {
    run = hydrate(saved.run);
  } catch {
    run = null;
  }
  const players = Array.isArray(saved.players) ? saved.players.filter((p) => p && p.id && p.name) : [];
  const history = Array.isArray(saved.history) ? saved.history.filter((h) => h && h.id && h.text).slice(0, HISTORY_MAX) : [];
  const day = Number(saved.weekday);
  const weekday = saved.weekday !== null && saved.weekday !== undefined && Number.isInteger(day) && day >= 0 && day <= 6 ? day : null;
  return {
    id: saved.id || newId(),
    name: String(saved.name || fallbackName || 'Minha pelada').trim().slice(0, NAME_MAX) || 'Minha pelada',
    weekday,
    players,
    config,
    run,
    history,
  };
}

function load() {
  let saved = store.read(KEY);
  if (!saved || !Array.isArray(saved.groups) || !saved.groups.length) {
    // primeira abertura desta versão: os dados da versão anterior viram a primeira pelada
    const old = store.read(KEY_V1) || {};
    saved = { groups: [{ ...old, name: 'Minha pelada' }], tutorialSeen: Boolean(old.tutorialSeen), currentId: null };
  }
  const groups = saved.groups.map((g, i) => cleanGroup(g, `Pelada ${i + 1}`));
  const currentId = groups.some((g) => g.id === saved.currentId) ? saved.currentId : groups[0].id;
  return { groups, currentId, tutorialSeen: Boolean(saved.tutorialSeen) };
}

/** G guarda tudo; S é um atalho para a pelada que está aberta, para o resto do código não precisar saber de grupos. */
let G = load();
const cur = () => G.groups.find((g) => g.id === G.currentId) || G.groups[0];
const S = {
  get players() { return cur().players; },
  set players(v) { cur().players = v; },
  get config() { return cur().config; },
  set config(v) { cur().config = v; },
  get run() { return cur().run; },
  set run(v) { cur().run = v; },
  get history() { return cur().history; },
  set history(v) { cur().history = v; },
  get tutorialSeen() { return G.tutorialSeen; },
  set tutorialSeen(v) { G.tutorialSeen = v; },
};
const ui = {
  screen: cur().run ? 'run' : 'groups',
  groupForm: null,
  tutorial: null,
  lastOverlay: '',
  lastAnnounce: '',
  sheet: null,
  reveal: null,
  revealTimer: null,
  showEvents: false,
  lastKey: '',
};

const run = () => S.run;
if (!S.tutorialSeen && !S.run) ui.tutorial = { step: 0 };

function persist() {
  store.write({
    version: 2,
    currentId: G.currentId,
    tutorialSeen: G.tutorialSeen,
    groups: G.groups.map((g) => ({ ...g, run: dehydrate(g.run) })),
  });
}

function commit() {
  persist();
  render();
}

/* ---------------------------------------------------------------- aviso (toast) */

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------------------------------------------------------------- jogadores */

function parsePlayerLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/^\s*(?:\d+\s*[.)\-:]|[-•*])\s*/, '').trim();
    if (!line) continue;
    const [name, aliasPart = ''] = line.split('|');
    const aliases = aliasPart
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (name.trim()) out.push({ name: name.trim(), aliases });
  }
  return out;
}

function addPlayers(list) {
  let added = 0;
  const known = new Set(S.players.map((p) => normalize(p.name)));
  for (const { name, aliases } of list) {
    const key = normalize(name);
    if (!key || known.has(key)) continue;
    known.add(key);
    S.players.push({ id: newId(), name, aliases });
    added++;
  }
  S.players.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return added;
}

const rosterById = (id) => (run()?.roster || []).find((p) => p.id === id) || { id, name: '(sem nome)', aliases: [] };

/* ---------------------------------------------------------------- cores e times */

const teamColor = (i) => paletteById(run().colors[i]);
const colorStyle = (c) => `--bg-team:${c.hex};--fg-team:${c.text}`;
const chip = (i) => {
  const c = teamColor(i);
  return `<span class="chip" style="${colorStyle(c)}">${c.name}</span>`;
};

/* ---------------------------------------------------------------- configuração */

function presentIds() {
  const have = new Set(S.players.map((p) => p.id));
  return S.config.present.filter((id) => have.has(id));
}

function setupInfo() {
  const c = S.config;
  const headcount = c.mode === 'names' ? presentIds().length : c.headcount;
  const slots = Math.min(headcount, c.teams * c.perTeam);
  const blocking = [];
  const warnings = [];
  if (headcount < c.teams) {
    blocking.push(
      c.mode === 'names'
        ? `Marque ao menos ${c.teams} jogadores presentes.`
        : `Informe ao menos ${c.teams} pessoas.`,
    );
  }
  if (headcount > slots) {
    const out = headcount - slots;
    warnings.push(
      `Com ${c.teams} times de até ${c.perTeam}, ${out} ${out === 1 ? 'pessoa fica' : 'pessoas ficam'} sem time. Aumente o tamanho do time se quiser incluir todos.`,
    );
  }
  if (c.minutes === 0 && c.goals === 0) {
    warnings.push('Sem limite de tempo nem de gols: a partida só termina quando alguém encerrar.');
  }
  return { headcount, slots, blocking, warnings };
}

function startRun() {
  const info = setupInfo();
  if (info.blocking.length) return;
  if (S.run && S.run.phase !== 'summary' && !confirm('Descartar o jogo em andamento e começar outro?')) return;
  const c = S.config;
  const ids = c.mode === 'names' ? presentIds() : [];
  const roster = S.players.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, name: p.name, aliases: [...p.aliases] }));
  const quotas = LiveDraw.evenQuotas(info.headcount, c.teams, c.perTeam);
  S.run = {
    mode: c.mode,
    teamCount: c.teams,
    colors: c.colors.slice(0, c.teams),
    headcount: info.headcount,
    roster,
    sound: c.sound,
    startedAt: Date.now(),
    phase: 'draw',
    matchNo: 0,
    draw: new LiveDraw(quotas),
    session: new Session(c.teams, new SessionRules(MatchRules.of(c.minutes, c.goals), c.streak, c.draw)),
    match: null,
  };
  ui.screen = 'run';
  ui.sheet = null;
  ui.reveal = null;
  commit();
}

/* ---------------------------------------------------------------- telas */

function header() {
  const toList = ui.screen === 'home' || ui.screen === 'groupform';
  const back = ui.screen === 'groups' ? '' : toList ? '<button class="link" data-act="groups">‹ Peladas</button>' : '<button class="link" data-act="home">‹ Pelada</button>';
  const brand = ui.screen === 'groups' || ui.screen === 'groupform' ? 'Organiza Rachão' : cur().name;
  return `<header class="top">${back}<span class="brand">${esc(brand)}</span></header>`;
}

function phaseLabel(r) {
  if (r.phase === 'draw') return `Sorteio: ${r.draw.drawnTotal()} de ${r.draw.totalSlots()}`;
  if (r.phase === 'teams') return 'Times prontos';
  if (r.phase === 'summary') return 'Resumo do jogo';
  const m = r.match;
  return m ? `Partida ${r.matchNo}: ${paletteById(r.colors[m.teamA]).name} × ${paletteById(r.colors[m.teamB]).name}` : '';
}

function viewHome() {
  const r = run();
  return `<section class="stack">
    <div class="hero"><h1>${esc(cur().name)}</h1><p class="muted">${esc(groupSubtitle(cur()))}</p></div>
    ${r ? `<button class="btn primary big" data-act="resume">Continuar jogo<small>${esc(phaseLabel(r))}</small></button>` : ''}
    <button class="btn ${r ? '' : 'primary'} big" data-act="new">Novo jogo</button>
    <button class="btn big" data-act="players">Jogadores<small>${S.players.length} cadastrados</small></button>
    <button class="btn big" data-act="history">Histórico<small>${S.history.length ? `${S.history.length} ${S.history.length === 1 ? 'jogo guardado' : 'jogos guardados'}` : 'nenhuma ainda'}</small></button>
    <button class="btn" data-act="editgroup" data-id="${esc(cur().id)}">Editar esta pelada</button>
  </section>`;
}

function viewPlayers() {
  const rows = S.players
    .map(
      (p) => `<div class="card player-row">
        <input type="text" value="${esc(p.name)}" data-pf="name" data-id="${p.id}" aria-label="Nome" autocomplete="off">
        <button class="btn danger sm" data-act="delplayer" data-id="${p.id}">Remover ${esc(p.name)}</button>
      </div>`,
    )
    .join('');
  return `<section class="stack">
    <h2>Jogadores<small>${S.players.length}</small></h2>
    <form class="card stack" data-form="addplayer">
      <h3>Adicionar um</h3>
      <input type="text" name="name" placeholder="Nome" autocomplete="off" aria-label="Nome do jogador">
      <button class="btn primary" type="submit">Adicionar</button>
    </form>
    <form class="card stack" data-form="bulk">
      <h3>Colar uma lista</h3>
      <p class="fine">Um nome por linha. Números e marcadores no começo são ignorados.</p>
      <textarea name="list" placeholder="1. Zé Carlos | Carlão&#10;2. João Pedro" aria-label="Lista de jogadores"></textarea>
      <button class="btn" type="submit">Adicionar da lista</button>
    </form>
    ${S.players.length ? `<div class="card stack"><h3>Backup da lista</h3><p class="fine">Copie a lista para guardar ou levar a outro aparelho. Para restaurar, cole em "Colar uma lista".</p><button class="btn" data-act="copylist">Copiar lista de jogadores</button></div>` : ''}
    ${rows || '<p class="muted">Ninguém cadastrado ainda.</p>'}
  </section>`;
}

function stepper(label, hint, field, fmt = (v) => v) {
  const [min, max] = LIMITS[field];
  const v = S.config[field];
  return `<div class="field">
    <div class="lbl">${label}${hint ? `<small>${hint}</small>` : ''}</div>
    <div class="stepper">
      <button data-act="step" data-f="${field}" data-d="-1" aria-label="Diminuir ${label}">−</button>
      <output>${fmt(v)}</output>
      <button data-act="step" data-f="${field}" data-d="1" aria-label="Aumentar ${label}">+</button>
    </div>
  </div>`;
}

function viewSetup() {
  const c = S.config;
  const info = setupInfo();
  const colorRows = Array.from({ length: c.teams }, (_, i) => {
    const cur = paletteById(c.colors[i]);
    const opts = PALETTE.map((p) => `<option value="${p.id}" ${p.id === cur.id ? 'selected' : ''}>${p.name}</option>`).join('');
    return `<div class="field">
      <div class="lbl">Time ${i + 1}<small>${i < 2 ? 'começa jogando' : 'espera na fila'}</small></div>
      <span class="swatch" style="background:${cur.hex}"></span>
      <select data-teamcolor="${i}" aria-label="Cor do time ${i + 1}">${opts}</select>
    </div>`;
  }).join('');

  let who;
  if (c.mode === 'names') {
    const present = new Set(presentIds());
    who = S.players.length
      ? `<div class="card stack">
          <h3>Quem veio hoje <span class="muted">(${present.size} marcados)</span></h3>
          <div class="checks">${S.players
            .map(
              (p) => `<label class="check"><input type="checkbox" data-present="${p.id}" ${present.has(p.id) ? 'checked' : ''}><span>${esc(p.name)}</span></label>`,
            )
            .join('')}</div>
          <div class="row2"><button class="btn sm" data-act="presentall">Marcar todos</button><button class="btn sm" data-act="presentnone">Limpar</button></div>
        </div>`
      : `<div class="card stack"><h3>Quem veio hoje</h3><p class="muted">Você ainda não cadastrou jogadores.</p><button class="btn primary" data-act="players">Cadastrar jogadores</button></div>`;
  } else {
    who = `<div class="card">${stepper('Quantas pessoas', 'incluindo goleiros', 'headcount')}</div>`;
  }

  const issues = [
    ...info.blocking.map((m) => `<div class="notice block">${esc(m)}</div>`),
    ...info.warnings.map((m) => `<div class="notice warn">${esc(m)}</div>`),
  ].join('');

  return `<section class="stack">
    <h2>Novo jogo</h2>
    <div class="card stack">
      <h3>Como sortear</h3>
      <div class="seg" role="group" aria-label="Como sortear">
        <button class="${c.mode === 'names' ? 'on' : ''}" aria-pressed="${c.mode === 'names'}" data-act="mode" data-v="names">Com nomes</button>
        <button class="${c.mode === 'color' ? 'on' : ''}" aria-pressed="${c.mode === 'color'}" data-act="mode" data-v="color">Só cores</button>
      </div>
      <p class="fine">${c.mode === 'names' ? 'Cada jogador fala ou toca o próprio nome e vê a cor do seu time.' : 'Cada um toca no botão e vê a cor. O app não guarda quem é quem.'}</p>
    </div>
    ${who}
    <div class="card">
      <h3>Times</h3>
      ${stepper('Número de times', '', 'teams')}
      ${stepper('Jogadores por time', 'inclui o goleiro', 'perTeam')}
      ${colorRows}
    </div>
    <div class="card">
      <h3>Regras da partida</h3>
      ${stepper('Tempo', 'minutos; 0 = sem limite', 'minutes', (v) => (v === 0 ? '∞' : v))}
      ${stepper('Gols para encerrar', '0 = sem limite', 'goals', (v) => (v === 0 ? '∞' : v))}
      ${stepper('Vitórias seguidas', 'depois disso o time sai; 0 = sem limite', 'streak', (v) => (v === 0 ? '∞' : v))}
      <div class="field">
        <div class="lbl">Se empatar<small>quem sai da quadra</small></div>
        <select data-cfg="draw" aria-label="Regra de empate">${Object.entries(DRAW_LABELS)
          .map(([k, label]) => `<option value="${k}" ${c.draw === k ? 'selected' : ''}>${label}</option>`)
          .join('')}</select>
      </div>
      <div class="field">
        <div class="lbl">Som e vibração no fim<small>aviso quando a partida acaba</small></div>
        <label class="check"><input type="checkbox" data-sound ${c.sound ? 'checked' : ''}><span>${c.sound ? 'Ligado' : 'Desligado'}</span></label>
      </div>
    </div>
    ${issues}
    <button class="btn primary big" data-act="start" ${info.blocking.length ? 'disabled' : ''}>Ir para o sorteio<small>${info.slots} vagas em ${c.teams} times</small></button>
  </section>`;
}

function viewDraw() {
  const r = run();
  const drawn = r.draw.drawnTotal();
  const total = r.draw.totalSlots();
  const pct = total ? Math.round((drawn / total) * 100) : 0;
  const head = `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${drawn}"><div class="bar" style="width:${pct}%"></div></div>
    <h2>Sorteio<small>${drawn} de ${total}</small></h2>`;
  const foot = `<div class="row2">
      <button class="btn" data-act="undodraw" ${drawn === 0 ? 'disabled' : ''}>Desfazer último</button>
      <button class="btn" data-act="finishdraw">Finalizar sorteio</button>
    </div>`;

  if (r.mode === 'color') {
    return `<section class="stack">${head}
      <p class="muted">Um de cada vez: toque no botão e guarde a sua cor.</p>
      <button class="btn primary huge" data-act="drawcolor" ${r.draw.remainingTotal() === 0 ? 'disabled' : ''}>Sortear minha cor</button>
      <p class="fine">Não viu a cor? Use <b>Desfazer último</b> e sorteie de novo: a cor é a mesma.</p>
      ${foot}
    </section>`;
  }

  const pending = r.roster.filter((p) => !r.draw.hasDrawn(p.id));
  return `<section class="stack">${head}
    <p class="muted">Toque no seu nome para ver a sua cor.</p>
    <h3>${pending.length ? 'Quem ainda não sorteou' : 'Todos já sortearam'}</h3>
    <div class="names">${pending
      .map((p) => `<button class="btn" data-act="pick" data-id="${p.id}">${esc(p.name)}</button>`)
      .join('')}</div>
    <form class="inline" data-form="late">
      <input type="text" name="name" placeholder="Chegou agora? Digite o nome" autocomplete="off" aria-label="Nome de quem chegou agora">
      <button class="btn" type="submit">Entrar</button>
    </form>
    ${foot}
  </section>`;
}

function teamSize(r, i) {
  return r.mode === 'names' ? r.draw.members(i).length : r.draw.counts()[i];
}

function viewTeams() {
  const r = run();
  const s = r.session;
  const order = [s.holder, s.challenger, ...s.queue];
  const cards = order
    .map((t, pos) => {
      const col = teamColor(t);
      const where = pos === 0 ? 'Em campo' : pos === 1 ? 'Em campo' : `${pos - 1}º da fila`;
      const n = teamSize(r, t);
      let body;
      if (r.mode === 'names') {
        const ms = r.draw
          .members(t)
          .map(rosterById)
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
        body = ms.length
          ? `<ul class="members">${ms
              .map((p) => `<li><span>${esc(p.name)}</span><button class="btn sm" data-act="movesheet" data-id="${p.id}">Mover</button></li>`)
              .join('')}</ul>`
          : '<p class="teamnote">Ninguém neste time.</p>';
      } else {
        body = `<p class="teamnote">${n} ${n === 1 ? 'pessoa' : 'pessoas'} com esta cor.</p>`;
      }
      return `<div class="teamcard"><div class="teamhead" style="${colorStyle(col)}"><span>${col.name}</span><small>${where} · ${n}</small></div>${body}</div>`;
    })
    .join('');
  const missing = r.draw.remainingTotal();
  const left = r.mode === 'names' && missing === 0 ? r.roster.filter((p) => !r.draw.hasDrawn(p.id)) : [];
  const leftOut = left.length
    ? `<div class="notice warn"><b>Sem time (${left.length}):</b> ${left.map((p) => esc(p.name)).join(', ')}. Todas as vagas já foram sorteadas.</div>`
    : '';
  const canPick = s.history.length === 0 && r.matchNo === 0;
  const opts = (sel) => r.colors.map((_, t) => `<option value="${t}" ${t === sel ? 'selected' : ''}>${esc(teamColor(t).name)}</option>`).join('');
  const startPick = canPick
    ? `<div class="card"><h3>Quem começa jogando</h3>
        <div class="field"><div class="lbl">Primeiro time</div><select data-start="0" aria-label="Primeiro time em campo">${opts(s.holder)}</select></div>
        <div class="field"><div class="lbl">Segundo time</div><select data-start="1" aria-label="Segundo time em campo">${opts(s.challenger)}</select></div>
      </div>`
    : '';
  return `<section class="stack">
    <h2>Times</h2>
    <p class="muted">Começam jogando: ${chip(s.holder)} × ${chip(s.challenger)}</p>
    ${startPick}
    ${cards}
    ${leftOut}
    <button class="btn primary big" data-act="startmatch">Começar a primeira partida</button>
    ${missing > 0 ? `<button class="btn" data-act="backtodraw">Voltar ao sorteio (${missing} ${missing === 1 ? 'vaga' : 'vagas'})</button>` : ''}
  </section>`;
}

/* ---- partida ---- */

function clockParts(m) {
  const limited = m.rules.timeLimitMillis > 0;
  const text = limited ? mmss(Math.ceil(m.remainingMillis() / 1000)) : mmss(Math.floor(m.elapsedMillis() / 1000));
  const labels = {
    [State.WAITING]: 'Pronto para começar',
    [State.RUNNING]: limited ? 'Tempo restante' : 'Tempo de jogo',
    [State.PAUSED]: 'Pausado',
    [State.ENDED]: 'Fim de jogo',
  };
  return { text, label: labels[m.state] };
}

function eventsHtml(m, r) {
  let a = 0;
  let b = 0;
  const rows = [];
  for (const e of m.events) {
    const t = mmss(Math.floor(e.atMillis / 1000));
    if (e.type === 'GOAL') {
      e.team === m.teamA ? a++ : b++;
      rows.push(`<li><time>${t}</time><span>Gol do ${paletteById(r.colors[e.team]).name} (${a} × ${b})</span></li>`);
    } else if (e.type === 'UNDO_GOAL') {
      e.team === m.teamA ? a-- : b--;
      rows.push(`<li><time>${t}</time><span class="undone">Gol do ${paletteById(r.colors[e.team]).name} desfeito</span></li>`);
    } else if (e.type === 'START') rows.push(`<li><time>${t}</time><span>Começou</span></li>`);
    else if (e.type === 'PAUSE') rows.push(`<li><time>${t}</time><span>Pausa</span></li>`);
    else if (e.type === 'RESUME') rows.push(`<li><time>${t}</time><span>Retomou</span></li>`);
    else if (e.type === 'END') rows.push(`<li><time>${t}</time><span>Fim</span></li>`);
  }
  return rows.reverse().join('');
}

function viewMatch() {
  const r = run();
  const m = r.match;
  const { text, label } = clockParts(m);
  const next = r.session.queue[0];
  const goalsOff = m.state === State.WAITING || m.state === State.ENDED;
  const panel = (t) => {
    const col = teamColor(t);
    return `<div class="team" style="${colorStyle(col)}">
      <div class="tname">${col.name}</div>
      <div class="score" id="score-${t}" aria-label="Gols do ${col.name}">${m.score(t)}</div>
      <button class="goal" data-act="goal" data-team="${t}" ${goalsOff ? 'disabled' : ''}>+1 gol</button>
    </div>`;
  };
  let main;
  if (m.state === State.WAITING) main = `<button class="btn primary big" data-act="mstart">Iniciar partida</button>`;
  else if (m.state === State.RUNNING) main = `<button class="btn primary big" data-act="mpause">Pausar</button>`;
  else if (m.state === State.PAUSED) main = `<button class="btn primary big" data-act="mresume">Retomar</button>`;
  else main = '';
  const evs = eventsHtml(m, r);
  return `<section class="match">
    <div class="meta"><span>Partida ${r.matchNo}</span><span>${next !== undefined ? `Próximo: ${esc(teamColor(next).name)}` : 'Sem fila'}</span></div>
    <div class="clock ${m.state === State.PAUSED ? 'paused' : ''}" id="clock" role="timer" aria-label="Relógio da partida">${text}</div>
    <div class="clock-label" id="clock-label">${label}</div>
    <div class="scoreboard">${panel(m.teamA)}${panel(m.teamB)}</div>
    ${main}
    <div class="row2">
      <button class="btn" data-act="undogoal" ${m.goalStack.length === 0 || m.state === State.ENDED ? 'disabled' : ''}>Desfazer gol</button>
      <button class="btn" data-act="mend" ${goalsOff ? 'disabled' : ''}>Encerrar partida</button>
    </div>
    <div class="card">
      <button class="link" data-act="toggleevents" aria-expanded="${ui.showEvents}">${ui.showEvents ? 'Esconder lances' : `Ver lances (${m.events.length})`}</button>
      ${ui.showEvents ? `<ul class="events">${evs}</ul>` : ''}
    </div>
    <button class="btn danger" data-act="endsession">Encerrar o jogo</button>
  </section>`;
}

function standings(r) {
  const rows = r.colors.map((_, team) => ({ team, w: 0, d: 0, l: 0, gf: 0, ga: 0 }));
  for (const h of r.session.history) {
    const A = rows[h.teamA];
    const B = rows[h.teamB];
    A.gf += h.scoreA;
    A.ga += h.scoreB;
    B.gf += h.scoreB;
    B.ga += h.scoreA;
    if (h.winner === h.teamA) {
      A.w++;
      B.l++;
    } else if (h.winner === h.teamB) {
      B.w++;
      A.l++;
    } else {
      A.d++;
      B.d++;
    }
  }
  return rows.sort((x, y) => y.w - x.w || y.gf - y.ga - (x.gf - x.ga) || y.gf - x.gf || x.team - y.team);
}

function summaryText(r) {
  const name = (t) => paletteById(r.colors[t]).name;
  const date = new Date(r.startedAt).toLocaleDateString('pt-BR');
  const lines = [`${cur().name} · ${date}`, ''];
  r.session.history.forEach((h, i) => {
    lines.push(`${i + 1}) ${name(h.teamA)} ${h.scoreA} × ${h.scoreB} ${name(h.teamB)}`);
  });
  if (!r.session.history.length) lines.push('Nenhuma partida concluída.');
  lines.push('', 'Classificação (V-E-D, saldo de gols):');
  for (const s of standings(r)) lines.push(`${name(s.team)}: ${s.w}-${s.d}-${s.l}, saldo ${s.gf - s.ga > 0 ? '+' : ''}${s.gf - s.ga}`);
  return lines.join('\n');
}

function viewSummary() {
  const r = run();
  const rows = standings(r)
    .map(
      (s) => `<tr><td>${chip(s.team)}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td><td>${s.gf - s.ga > 0 ? '+' : ''}${s.gf - s.ga}</td></tr>`,
    )
    .join('');
  const games = r.session.history
    .map(
      (h, i) => `<li><time>${i + 1}</time><span>${chip(h.teamA)} ${h.scoreA} × ${h.scoreB} ${chip(h.teamB)}</span></li>`,
    )
    .join('');
  return `<section class="stack">
    <h2>Resumo do jogo</h2>
    <div class="card">
      <table><thead><tr><th>Time</th><th>V</th><th>E</th><th>D</th><th>Saldo</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="card"><h3>Partidas</h3>${games ? `<ul class="events">${games}</ul>` : '<p class="muted">Nenhuma partida concluída.</p>'}</div>
    <pre>${esc(summaryText(r))}</pre>
    <button class="btn primary big" data-act="share">Compartilhar resumo</button>
    <button class="btn" data-act="new">Novo jogo</button>
  </section>`;
}

function groupSubtitle(g) {
  const parts = [];
  if (g.weekday !== null) parts.push(WEEKDAYS[g.weekday]);
  parts.push(`${g.players.length} ${g.players.length === 1 ? 'jogador' : 'jogadores'}`);
  parts.push(`${g.history.length} ${g.history.length === 1 ? 'jogo' : 'jogos'}`);
  return parts.join(' · ');
}

function viewGroups() {
  const items = G.groups
    .map((g) => {
      const live = g.run && g.run.phase !== 'summary';
      return `<div class="card group">
        <button class="grp-main" data-act="selgroup" data-id="${esc(g.id)}">
          <span class="grp-name">${esc(g.name)}${live ? '<small class="tag live">jogo em andamento</small>' : ''}</span>
          <small>${esc(groupSubtitle(g))}</small>
        </button>
        <button class="btn sm" data-act="editgroup" data-id="${esc(g.id)}" aria-label="Editar ${esc(g.name)}">Editar</button>
      </div>`;
    })
    .join('');
  return `<section class="stack">
    <div class="hero"><h1>Organiza Rachão</h1><p class="muted">Sorteio de times, tempo e placar. Sem briga.</p></div>
    <h2>Minhas peladas<small>${G.groups.length}</small></h2>
    <p class="fine">Escolha uma pelada para jogar, ver os jogadores e o histórico. Cada uma tem os seus próprios dados.</p>
    ${items}
    <button class="btn primary big" data-act="newgroup">Nova pelada</button>
    <button class="btn" data-act="tutorial">Como funciona</button>
    <p class="fine">Sem conta. Tudo fica só neste aparelho. <a href="privacidade.html">Política de privacidade</a></p>
  </section>`;
}

function viewGroupForm() {
  const f = ui.groupForm;
  const editing = f.id ? G.groups.find((g) => g.id === f.id) : null;
  const days = ['<option value="">Sem dia fixo</option>']
    .concat(WEEKDAYS.map((d, i) => `<option value="${i}" ${f.weekday === i ? 'selected' : ''}>${d}</option>`))
    .join('');
  const copy = !editing && G.groups.length
    ? `<div class="field col"><label class="lbl" for="g-copy">Copiar jogadores e regras de<small>Opcional. Depois as duas peladas ficam independentes.</small></label>
        <select id="g-copy" name="copyfrom"><option value="">Começar do zero</option>${G.groups.map((g) => `<option value="${esc(g.id)}" ${f.copyfrom === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>`
    : '';
  return `<section class="stack">
    <h2>${editing ? 'Editar pelada' : 'Nova pelada'}</h2>
    <form class="card stack" data-form="group">
      <div class="field col"><label class="lbl" for="g-name">Nome</label>
        <input id="g-name" type="text" name="name" value="${esc(f.name)}" maxlength="${NAME_MAX}" placeholder="Ex.: Pelada da quarta" autocomplete="off"></div>
      <div class="field col"><label class="lbl" for="g-day">Dia da semana</label>
        <select id="g-day" name="weekday">${days}</select></div>
      ${copy}
      <button class="btn primary big" type="submit">${editing ? 'Salvar' : 'Criar pelada'}</button>
    </form>
    ${editing ? `<button class="btn danger" data-act="delgroup" data-id="${esc(editing.id)}">Apagar esta pelada</button>` : ''}
  </section>`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function saveHistory(r) {
  const n = r.session.history.length;
  if (!n) return;
  const entry = { id: String(r.startedAt), startedAt: r.startedAt, matches: n, text: summaryText(r) };
  S.history = [entry, ...S.history.filter((h) => h.id !== entry.id)].slice(0, HISTORY_MAX);
}

function viewHistory() {
  const items = S.history
    .map(
      (h) => `<details class="card hist">
        <summary><span>${esc(fmtDate(h.startedAt))}</span><small>${h.matches} ${h.matches === 1 ? 'partida' : 'partidas'}</small></summary>
        <pre>${esc(h.text)}</pre>
        <div class="row2"><button class="btn" data-act="sharehist" data-id="${esc(h.id)}">Compartilhar</button><button class="btn danger" data-act="delhist" data-id="${esc(h.id)}">Apagar</button></div>
      </details>`,
    )
    .join('');
  return `<section class="stack">
    <h2>Histórico<small>${S.history.length}</small></h2>
    <p class="fine">Os jogos encerrados desta pelada ficam guardados neste aparelho (até ${HISTORY_MAX}).</p>
    ${items || '<p class="muted">Nenhum jogo guardado ainda. Ele aparece aqui quando você encerra um jogo com ao menos uma partida.</p>'}
  </section>`;
}

const TUTORIAL = [
  { t: 'Uma pelada por grupo', p: 'Cada pelada (seu grupo e dia da semana) tem jogadores, regras e histórico próprios. Toque no nome dela na tela inicial para trocar ou criar outra. Em "Jogadores", cole a lista do grupo.' },
  { t: 'Sorteie na hora', p: 'Cada pessoa toca no próprio nome e vê a cor do time em tela cheia. Os times fecham no tamanho certo. Errou? "Desfazer último" devolve a mesma cor.' },
  { t: 'Jogue e marque', p: 'Inicie a partida, toque em "+1 gol" e use "Pausar" quando precisar. A partida termina pelo tempo ou pelos gols que você definir, e o gol errado tem desfazer.' },
  { t: 'A fila anda sozinha', p: 'Quem ganha fica, até o limite de vitórias. No fim o app mostra quem entra. Ao encerrar o jogo, o resumo vai para o histórico e para o WhatsApp.' },
];

function tutorialHtml() {
  const tu = ui.tutorial;
  if (!tu) return '';
  const last = tu.step === TUTORIAL.length - 1;
  const d = TUTORIAL[tu.step];
  const dots = TUTORIAL.map((_, i) => `<span class="dot-i ${i === tu.step ? 'on' : ''}" aria-hidden="true"></span>`).join('');
  return `<div class="sheet-bg"></div>
    <div class="sheet tutorial" role="dialog" aria-modal="true" aria-label="Como funciona, passo ${tu.step + 1} de ${TUTORIAL.length}">
      <div class="dots">${dots}<span class="fine">${tu.step + 1} de ${TUTORIAL.length}</span></div>
      <h3>${esc(d.t)}</h3>
      <p>${esc(d.p)}</p>
      <div class="row2"><button class="btn" data-act="tutskip">${last ? 'Fechar' : 'Pular'}</button><button class="btn primary" data-act="tutnext">${last ? 'Começar' : 'Próximo'}</button></div>
    </div>`;
}

function viewRun() {
  const r = run();
  if (!r) return viewHome();
  if (r.phase === 'draw') return viewDraw();
  if (r.phase === 'teams') return viewTeams();
  if (r.phase === 'match' && r.match) return viewMatch();
  return viewSummary();
}

/* ---------------------------------------------------------------- sobreposições */

function revealHtml() {
  const rv = ui.reveal;
  if (!rv) return '';
  if (rv.noSlot) {
    return `<div class="reveal" data-act="closereveal" role="dialog" aria-modal="true" aria-label="Sem vaga">
      <div class="rv-inner">${rv.name ? `<div class="rv-name">${esc(rv.name)}</div>` : ''}<div class="rv-color">Sem vaga</div><p>Todas as vagas já foram sorteadas.</p><small>Toque para fechar</small></div></div>`;
  }
  const col = teamColor(rv.team);
  return `<div class="reveal" style="${colorStyle(col)}" data-act="closereveal" role="dialog" aria-modal="true" aria-label="Seu time é ${col.name}">
    <div class="rv-inner">${rv.name ? `<div class="rv-name">${esc(rv.name)}</div>` : ''}<div class="rv-label">Seu time</div><div class="rv-color">${col.name}</div><small>Toque para fechar</small></div></div>`;
}

function sheetHtml() {
  const sh = ui.sheet;
  if (!sh) return '';
  if (sh.type === 'confirm') {
    const p = rosterById(sh.id);
    return `<div class="sheet-bg" data-act="closesheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Confirmar nome">
        <h3>Você é ${esc(p.name)}?</h3>
        <div class="row2"><button class="btn" data-act="closesheet">Não</button><button class="btn primary" data-act="confirmdraw" data-id="${p.id}">Sim, sortear</button></div>
      </div>`;
  }
  if (sh.type === 'move') {
    const p = rosterById(sh.id);
    const cur = run().draw.teamOf(sh.id);
    return `<div class="sheet-bg" data-act="closesheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Mover jogador">
        <h3>Mover ${esc(p.name)} para</h3>
        <div class="stack-btns">${run()
          .colors.map((_, t) => `<button class="btn" data-act="moveto" data-id="${p.id}" data-team="${t}" ${t === cur ? 'disabled' : ''}>${chip(t)}${t === cur ? ' (atual)' : ''}</button>`)
          .join('')}<button class="btn" data-act="closesheet">Cancelar</button></div>
      </div>`;
  }
  return '';
}

function endHtml() {
  const r = run();
  const m = r && r.phase === 'match' ? r.match : null;
  if (!m || m.state !== State.ENDED) return '';
  const name = (t) => paletteById(r.colors[t]).name;
  const p = r.session.preview(m);
  const w = m.winnerTeam();
  let why;
  if (w >= 0) {
    const winnerLeaves = p.holder !== w && p.challenger !== w;
    why = `${esc(name(w === m.teamA ? m.teamB : m.teamA))} vai para o fim da fila.`;
    if (winnerLeaves) why += ` ${esc(name(w))} chegou ao limite de ${r.session.rules.winStreakLimit} ${r.session.rules.winStreakLimit === 1 ? 'vitória' : 'vitórias'} seguidas e sai também.`;
  } else {
    const leavers = [m.teamA, m.teamB].filter((t) => t !== p.holder && t !== p.challenger);
    const stays = [m.teamA, m.teamB].filter((t) => t === p.holder || t === p.challenger);
    if (leavers.length === 2) why = 'Empate: saem os dois.';
    else if (leavers.length === 1) why = `Empate: sai ${esc(name(leavers[0]))} e fica ${esc(name(stays[0]))}.`;
    else why = 'Empate: os mesmos dois times seguem.';
  }
  const canUndo = m.endReason === EndReason.GOALS && m.goalStack.length > 0;
  return `<div class="end-bg"><div class="end" role="dialog" aria-modal="true" aria-label="Fim da partida">
    <h2>${w >= 0 ? `${esc(name(w))} venceu` : 'Empate'}</h2>
    <div class="result">
      <div class="t" style="${colorStyle(teamColor(m.teamA))}">${esc(name(m.teamA))}</div>
      <div class="x">${m.scoreA} × ${m.scoreB}</div>
      <div class="t" style="${colorStyle(teamColor(m.teamB))}">${esc(name(m.teamB))}</div>
    </div>
    <p class="muted">${REASON_LABELS[m.endReason]}</p>
    <div class="notice">
      <b>Próxima partida:</b> ${chip(p.holder)} × ${chip(p.challenger)}<br>
      <b>Fila:</b> ${p.queue.length ? p.queue.map(chip).join(' ') : 'ninguém esperando'}<br>
      <span class="fine">${why}</span>
    </div>
    <button class="btn primary big" data-act="nextmatch">Próxima partida</button>
    ${canUndo ? '<button class="btn" data-act="undogoal">Desfazer último gol</button>' : ''}
    <button class="btn danger" data-act="endsession">Encerrar o jogo</button>
  </div></div>`;
}

/* ---------------------------------------------------------------- render */

function render() {
  const screen = ui.screen === 'run' ? viewRun() : ui.screen === 'setup' ? viewSetup() : ui.screen === 'players' ? viewPlayers() : ui.screen === 'history' ? viewHistory() : ui.screen === 'groups' ? viewGroups() : ui.screen === 'groupform' ? viewGroupForm() : viewHome();
  $('#app').innerHTML = header() + `<main>${screen}</main>`;
  const ovKind = ui.tutorial ? 'tut' : ui.reveal ? 'reveal' : ui.sheet ? 'sheet:' + ui.sheet.type : endHtml() ? 'end' : '';
  $('#overlay').innerHTML = tutorialHtml() || (ui.reveal ? revealHtml() : '') || sheetHtml() || endHtml();
  if (ovKind !== ui.lastOverlay) {
    ui.lastOverlay = ovKind;
    if (ovKind) {
      const target = $('#overlay .reveal') || $('#overlay .btn.primary') || $('#overlay button');
      if (target) {
        if (!target.hasAttribute('tabindex') && !target.matches('button')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }
  }
  const key = `${ui.screen}|${run()?.phase || ''}|${run()?.matchNo || 0}`;
  if (key !== ui.lastKey) {
    ui.lastKey = key;
    window.scrollTo(0, 0);
  }
}

/* ---------------------------------------------------------------- som, vibração e tela acesa */

let audio = null;
function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

function buzzer() {
  if (!run()?.sound) return;
  try {
    navigator.vibrate?.([300, 120, 300, 120, 600]);
  } catch {
    /* sem vibração */
  }
  if (!audio) return;
  const t0 = audio.currentTime;
  [0, 0.4, 0.8].forEach((d, i) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'square';
    o.frequency.value = i === 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.3);
    o.connect(g).connect(audio.destination);
    o.start(t0 + d);
    o.stop(t0 + d + 0.32);
  });
}

let wake = null;
async function updateWakeLock() {
  const r = run();
  const want = Boolean(r && r.phase === 'match' && r.match && (r.match.state === State.RUNNING || r.match.state === State.PAUSED));
  try {
    if (want && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock.request('screen');
      wake = lock;
      lock.addEventListener('release', () => {
        if (wake === lock) wake = null;
      });
    } else if (!want && wake) {
      const lock = wake;
      wake = null;
      await lock.release();
    }
  } catch {
    wake = null;
  }
}

/* ---------------------------------------------------------------- partida: ações */

function announce(text) {
  const el = $('#sr');
  if (el && text !== ui.lastAnnounce) {
    ui.lastAnnounce = text;
    el.textContent = text;
  }
}

function afterMatchChange(prevState) {
  const m = run().match;
  const nm = (t) => teamColor(t).name;
  announce(`${nm(m.teamA)} ${m.scoreA}, ${nm(m.teamB)} ${m.scoreB}.${m.state === State.ENDED ? ' Fim da partida.' : m.state === State.PAUSED ? ' Pausado.' : ''}`);
  if (m.state === State.ENDED && prevState !== State.ENDED) buzzer();
  updateWakeLock();
  commit();
}

function matchAct(fn) {
  const r = run();
  if (!r || !r.match) return;
  const prev = r.match.state;
  try {
    fn(r.match);
  } catch {
    /* corrida com o fim do tempo: a tela se acerta no commit abaixo */
  }
  afterMatchChange(prev);
}

function tick() {
  const r = run();
  if (!r || r.phase !== 'match' || !r.match) return;
  const m = r.match;
  const prev = m.state;
  m.tick();
  if (m.state !== prev) {
    afterMatchChange(prev);
    return;
  }
  if (ui.screen !== 'run') return;
  const { text, label } = clockParts(m);
  const c = $('#clock');
  if (c && c.textContent !== text) c.textContent = text;
  const l = $('#clock-label');
  if (l && l.textContent !== label) l.textContent = label;
}

/* ---------------------------------------------------------------- sorteio: ações */

function showReveal(rv) {
  ui.reveal = { ...rv, at: Date.now() };
  clearTimeout(ui.revealTimer);
  ui.revealTimer = setTimeout(() => closeReveal(true), 3000);
  render();
}

function closeReveal(force) {
  if (!ui.reveal) return;
  if (!force && Date.now() - ui.reveal.at < 600) return;
  clearTimeout(ui.revealTimer);
  ui.reveal = null;
  const r = run();
  if (r && r.phase === 'draw' && r.draw.remainingTotal() === 0) r.phase = 'teams';
  commit();
}

function doReveal(id) {
  const r = run();
  const p = rosterById(id);
  let team;
  try {
    team = r.draw.reveal(id);
  } catch {
    toast('Esse jogador já foi sorteado.');
    render();
    return;
  }
  persist();
  showReveal(team < 0 ? { noSlot: true, name: p.name } : { team, name: p.name });
}

function endSession() {
  const r = run();
  const m = r.match;
  if (m && m.state === State.ENDED) {
    r.session.finish(m);
  } else if (m && m.state !== State.WAITING && !confirm('A partida em andamento não será contada. Encerrar o jogo mesmo assim?')) {
    return;
  } else if (!m && !confirm('Encerrar o jogo?')) {
    return;
  }
  r.match = null;
  r.phase = 'summary';
  saveHistory(r);
  updateWakeLock();
  commit();
}

async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Resumo copiado.');
  } catch {
    toast('Não consegui copiar. Selecione o texto na tela.');
  }
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        /* cancelado */
      }
    }
    toast('Não consegui copiar. Selecione o texto e copie.');
  }
}

/** Abre outra pelada. Um jogo com relógio correndo na pelada anterior é pausado para não perder tempo nem alarme. */
function openGroup(id) {
  const target = G.groups.find((g) => g.id === id);
  if (!target) return;
  if (target.id !== G.currentId) {
    const m = cur().run?.match;
    if (m && m.state === State.RUNNING) {
      m.pause();
      toast(`Partida de "${cur().name}" pausada.`);
    }
    G.currentId = target.id;
    ui.sheet = null;
    ui.reveal = null;
    clearTimeout(ui.revealTimer);
  }
  ui.screen = 'home';
  updateWakeLock();
  commit();
}

/* ---------------------------------------------------------------- eventos */

const actions = {
  home() {
    ui.screen = 'home';
    render();
  },
  groups() {
    ui.screen = 'groups';
    ui.groupForm = null;
    render();
  },
  selgroup(el) {
    openGroup(el.dataset.id);
  },
  newgroup() {
    ui.groupForm = { id: null, name: '', weekday: null, copyfrom: G.groups.length === 1 ? G.groups[0].id : '' };
    ui.screen = 'groupform';
    render();
    $('#g-name')?.focus();
  },
  editgroup(el) {
    const g = G.groups.find((x) => x.id === el.dataset.id);
    if (!g) return;
    ui.groupForm = { id: g.id, name: g.name, weekday: g.weekday, from: ui.screen };
    ui.screen = 'groupform';
    render();
  },
  delgroup(el) {
    const g = G.groups.find((x) => x.id === el.dataset.id);
    if (!g) return;
    const extra = g.players.length || g.history.length ? ` Os ${g.players.length} jogadores e os ${g.history.length} jogos do histórico serão apagados.` : '';
    if (!confirm(`Apagar a pelada "${g.name}"?${extra} Não dá para desfazer.`)) return;
    G.groups = G.groups.filter((x) => x.id !== g.id);
    if (!G.groups.length) G.groups.push(cleanGroup({}, 'Minha pelada'));
    if (G.currentId === g.id) G.currentId = G.groups[0].id;
    ui.groupForm = null;
    ui.screen = 'groups';
    toast('Pelada apagada.');
    commit();
  },
  resume() {
    ui.screen = 'run';
    render();
  },
  new() {
    ui.screen = 'setup';
    render();
  },
  players() {
    ui.screen = 'players';
    render();
  },
  history() {
    ui.screen = 'history';
    render();
  },
  tutorial() {
    ui.tutorial = { step: 0 };
    render();
  },
  tutnext() {
    if (!ui.tutorial) return;
    if (ui.tutorial.step >= TUTORIAL.length - 1) return actions.tutskip();
    ui.tutorial.step++;
    render();
  },
  tutskip() {
    ui.tutorial = null;
    S.tutorialSeen = true;
    commit();
  },
  copylist() {
    const text = S.players.map((p) => (p.aliases && p.aliases.length ? `${p.name} | ${p.aliases.join(', ')}` : p.name)).join('\n');
    copyText(text, 'Lista copiada.');
  },
  sharehist(el) {
    const h = S.history.find((x) => x.id === el.dataset.id);
    if (h) shareText(h.text);
  },
  delhist(el) {
    const h = S.history.find((x) => x.id === el.dataset.id);
    if (!h || !confirm(`Apagar o jogo de ${fmtDate(h.startedAt)} do histórico?`)) return;
    S.history = S.history.filter((x) => x.id !== h.id);
    commit();
  },
  step(el) {
    const f = el.dataset.f;
    const [lo, hi] = LIMITS[f];
    S.config[f] = clamp(S.config[f] + Number(el.dataset.d), lo, hi);
    commit();
  },
  mode(el) {
    S.config.mode = el.dataset.v === 'color' ? 'color' : 'names';
    commit();
  },
  presentall() {
    S.config.present = S.players.map((p) => p.id);
    commit();
  },
  presentnone() {
    S.config.present = [];
    commit();
  },
  start: startRun,
  delplayer(el) {
    const p = S.players.find((x) => x.id === el.dataset.id);
    if (!p || !confirm(`Remover ${p.name} da lista de jogadores?`)) return;
    S.players = S.players.filter((x) => x.id !== p.id);
    S.config.present = S.config.present.filter((id) => id !== p.id);
    commit();
  },

  /* sorteio */
  pick(el) {
    ui.sheet = { type: 'confirm', id: el.dataset.id };
    render();
  },
  confirmdraw(el) {
    ui.sheet = null;
    doReveal(el.dataset.id);
  },
  closesheet() {
    ui.sheet = null;
    render();
  },
  drawcolor() {
    const team = run().draw.reveal();
    if (team < 0) {
      toast('Não há mais vagas.');
      return;
    }
    persist();
    showReveal({ team });
  },
  closereveal() {
    closeReveal(false);
  },
  undodraw() {
    const u = run().draw.undoLast();
    toast(u ? 'Último sorteio desfeito.' : 'Nada para desfazer.');
    commit();
  },
  finishdraw() {
    const r = run();
    const left = r.draw.remainingTotal();
    if (left > 0 && !confirm(`Ainda ${left === 1 ? 'falta 1 vaga' : `faltam ${left} vagas`}. Finalizar o sorteio mesmo assim?`)) return;
    r.phase = 'teams';
    commit();
  },
  backtodraw() {
    run().phase = 'draw';
    commit();
  },
  movesheet(el) {
    ui.sheet = { type: 'move', id: el.dataset.id };
    render();
  },
  moveto(el) {
    run().draw.move(el.dataset.id, Number(el.dataset.team));
    ui.sheet = null;
    commit();
  },
  startmatch() {
    const r = run();
    r.match = r.session.newMatch(clock);
    r.matchNo = r.session.history.length + 1;
    r.phase = 'match';
    commit();
  },

  /* partida */
  mstart() {
    unlockAudio();
    matchAct((m) => m.start());
  },
  mpause() {
    matchAct((m) => m.pause());
  },
  mresume() {
    unlockAudio();
    matchAct((m) => m.resume());
  },
  goal(el) {
    matchAct((m) => m.goal(Number(el.dataset.team)));
  },
  undogoal() {
    const m = run().match;
    if (!m || m.goalStack.length === 0) {
      toast('Nenhum gol para desfazer.');
      return;
    }
    matchAct((x) => {
      if (!x.undo()) toast('Depois do fim do tempo não dá para desfazer.');
    });
  },
  mend() {
    if (!confirm('Encerrar esta partida agora?')) return;
    matchAct((m) => m.endManually());
  },
  toggleevents() {
    ui.showEvents = !ui.showEvents;
    render();
  },
  nextmatch() {
    const r = run();
    if (!r.match || r.match.state !== State.ENDED) return;
    r.session.finish(r.match);
    r.match = r.session.newMatch(clock);
    r.matchNo = r.session.history.length + 1;
    ui.showEvents = false;
    updateWakeLock();
    commit();
  },
  endsession: endSession,
  share() {
    shareText(summaryText(run()));
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  unlockAudio();
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-present]')) {
    const id = t.dataset.present;
    const set = new Set(S.config.present);
    t.checked ? set.add(id) : set.delete(id);
    S.config.present = [...set];
    commit();
  } else if (t.matches('[data-teamcolor]')) {
    const i = Number(t.dataset.teamcolor);
    const colors = S.config.colors.slice();
    const j = colors.indexOf(t.value);
    if (j >= 0 && j !== i) [colors[i], colors[j]] = [colors[j], colors[i]];
    S.config.colors = colors;
    commit();
  } else if (t.matches('[data-start]')) {
    const s = run().session;
    const slot = Number(t.dataset.start);
    const pick = Number(t.value);
    let a = s.holder;
    let b = s.challenger;
    if (slot === 0) {
      if (pick === b) b = a;
      a = pick;
    } else {
      if (pick === a) a = b;
      b = pick;
    }
    try {
      s.setStart(a, b);
    } catch {
      toast('Não dá mais para trocar quem começa.');
    }
    commit();
  } else if (t.matches('[data-cfg]')) {
    S.config[t.dataset.cfg] = t.value;
    commit();
  } else if (t.matches('[data-sound]')) {
    S.config.sound = t.checked;
    commit();
  } else if (t.matches('[data-pf]')) {
    const p = S.players.find((x) => x.id === t.dataset.id);
    if (!p) return;
    if (t.dataset.pf === 'name') {
      const v = t.value.trim();
      if (v) p.name = v;
      else t.value = p.name;
    } else {
      p.aliases = t.value.split(',').map((a) => a.trim()).filter(Boolean);
    }
    persist();
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const data = new FormData(form);
  if (kind === 'addplayer') {
    const name = String(data.get('name') || '').trim();
    if (!name) {
      toast('Digite um nome.');
      return;
    }
    const aliases = String(data.get('aliases') || '').split(',').map((a) => a.trim()).filter(Boolean);
    const added = addPlayers([{ name, aliases }]);
    if (!added) toast('Esse jogador já está na lista.');
    commit();
    $('[name=name]')?.focus();
  } else if (kind === 'group') {
    const f = ui.groupForm;
    const name = String(data.get('name') || '').trim().slice(0, NAME_MAX);
    if (!name) {
      toast('Dê um nome para a pelada.');
      $('#g-name')?.focus();
      return;
    }
    if (G.groups.some((g) => g.id !== f.id && normalize(g.name) === normalize(name))) {
      toast('Já existe uma pelada com esse nome.');
      return;
    }
    const wd = String(data.get('weekday') || '');
    const weekday = wd === '' ? null : Number(wd);
    if (f.id) {
      const g = G.groups.find((x) => x.id === f.id);
      g.name = name;
      g.weekday = weekday;
      ui.screen = f.from === 'home' ? 'home' : 'groups';
      ui.groupForm = null;
      toast('Pelada salva.');
      commit();
    } else {
      const src = G.groups.find((g) => g.id === data.get('copyfrom'));
      const base = src ? { players: structuredClone(src.players), config: structuredClone(src.config) } : {};
      if (base.config) base.config.present = [];
      const g = cleanGroup({ ...base, name, weekday }, name);
      g.id = newId();
      G.groups.push(g);
      ui.groupForm = null;
      openGroup(g.id);
    }
  } else if (kind === 'bulk') {
    const added = addPlayers(parsePlayerLines(String(data.get('list') || '')));
    toast(added ? `${added} ${added === 1 ? 'jogador adicionado' : 'jogadores adicionados'}.` : 'Ninguém novo para adicionar.');
    commit();
  } else if (kind === 'late') {
    const name = String(data.get('name') || '').trim();
    const r = run();
    if (!name || !r) return;
    const key = normalize(name);
    let p = r.roster.find((x) => normalize(x.name) === key);
    if (!p) {
      let known = S.players.find((x) => normalize(x.name) === key);
      if (!known) {
        known = { id: newId(), name, aliases: [] };
        S.players.push(known);
        S.players.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      }
      p = { id: known.id, name: known.name, aliases: [...known.aliases] };
      r.roster.push(p);
    }
    if (r.draw.hasDrawn(p.id)) {
      toast(`${p.name} já sorteou.`);
      return;
    }
    persist();
    ui.sheet = { type: 'confirm', id: p.id };
    render();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    tick();
    updateWakeLock();
    if (ui.reveal) closeReveal(false);
  } else {
    persist();
  }
});
window.addEventListener('pagehide', persist);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ui.tutorial) actions.tutskip();
  else if (ui.reveal) closeReveal(false);
  else if (ui.sheet) actions.closesheet();
});


setInterval(tick, 100);
render();
updateWakeLock();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
