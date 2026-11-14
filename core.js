/*
 * Núcleo de regras da pelada. Sem DOM, sem armazenamento: só lógica.
 * Porte do núcleo Java (../core), com serialização para sobreviver a recarregar a página.
 *
 * O relógio é uma função () => milissegundos, injetada. No app: Date.now.
 */

export const State = Object.freeze({
  WAITING: 'WAITING',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  ENDED: 'ENDED',
});

export const EndReason = Object.freeze({ TIME: 'TIME', GOALS: 'GOALS', MANUAL: 'MANUAL' });

/**
 * AUTO: saem os dois se houver pelo menos 2 times esperando; senão sai quem estava
 * em campo e fica quem estava entrando.
 */
export const DrawPolicy = Object.freeze({
  AUTO: 'AUTO',
  BOTH_LEAVE: 'BOTH_LEAVE',
  CHALLENGER_STAYS: 'CHALLENGER_STAYS',
});

function need(ok, message) {
  if (!ok) throw new Error(message);
}

/** Gerador pseudoaleatório com semente, para testes reproduzíveis. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ---------------------------------------------------------------- regras

/** Limites da partida. Zero significa "sem limite". */
export class MatchRules {
  constructor(timeLimitMillis, goalLimit) {
    if (!(timeLimitMillis >= 0) || !(goalLimit >= 0)) {
      throw new RangeError('limites não podem ser negativos');
    }
    this.timeLimitMillis = timeLimitMillis;
    this.goalLimit = goalLimit;
  }

  static of(minutes, goals) {
    return new MatchRules(minutes * 60000, goals);
  }
}

export class SessionRules {
  constructor(match, winStreakLimit, drawPolicy) {
    if (!(winStreakLimit >= 0)) throw new RangeError('limite negativo');
    this.match = match;
    this.winStreakLimit = winStreakLimit;
    this.drawPolicy = drawPolicy;
  }

  toJSON() {
    return {
      timeLimitMillis: this.match.timeLimitMillis,
      goalLimit: this.match.goalLimit,
      winStreakLimit: this.winStreakLimit,
      drawPolicy: this.drawPolicy,
    };
  }

  static fromJSON(o) {
    return new SessionRules(
      new MatchRules(o.timeLimitMillis, o.goalLimit),
      o.winStreakLimit,
      o.drawPolicy,
    );
  }
}

// ---------------------------------------------------------------- partida

/**
 * Uma partida entre dois times. O tempo vem do relógio (início + acumulado antes de
 * cada pausa), nunca de contagem de "ticks", então não acelera nem atrasa se a página
 * ficar em segundo plano.
 */
export class Match {
  constructor(teamA, teamB, rules, clock) {
    if (teamA === teamB) throw new RangeError('os dois times precisam ser diferentes');
    this.teamA = teamA;
    this.teamB = teamB;
    this.rules = rules;
    this.clock = clock;
    this.state = State.WAITING;
    this.endReason = null;
    this.accumulated = 0;
    this.runningSince = -1;
    this.scoreA = 0;
    this.scoreB = 0;
    /** @type {{type:string, team:number, atMillis:number}[]} */
    this.events = [];
    this.goalStack = [];
  }

  score(team) {
    if (team === this.teamA) return this.scoreA;
    if (team === this.teamB) return this.scoreB;
    throw new RangeError('time fora da partida: ' + team);
  }

  /** Tempo de jogo decorrido, limitado ao tempo da partida quando há limite. */
  elapsedMillis() {
    let e = this.accumulated;
    if (this.state === State.RUNNING) e += Math.max(0, this.clock() - this.runningSince);
    const limit = this.rules.timeLimitMillis;
    if (limit > 0 && e > limit) e = limit;
    return e;
  }

  /** Tempo restante, ou -1 se não há limite de tempo. */
  remainingMillis() {
    const limit = this.rules.timeLimitMillis;
    if (limit === 0) return -1;
    return Math.max(0, limit - this.elapsedMillis());
  }

  /**
   * Encerra a partida se o tempo acabou. A interface chama isto a cada ~200 ms; as
   * demais operações também chamam por dentro.
   */
  tick() {
    const limit = this.rules.timeLimitMillis;
    if (this.state === State.RUNNING && limit > 0) {
      const raw = this.accumulated + Math.max(0, this.clock() - this.runningSince);
      if (raw >= limit) {
        this.accumulated = limit;
        this.runningSince = -1;
        this.state = State.ENDED;
        this.endReason = EndReason.TIME;
        this.events.push({ type: 'END', team: -1, atMillis: this.accumulated });
      }
    }
    return this.state;
  }

  start() {
    need(this.state === State.WAITING, 'a partida já começou');
    this.runningSince = this.clock();
    this.state = State.RUNNING;
    this.events.push({ type: 'START', team: -1, atMillis: 0 });
  }

  pause() {
    this.tick();
    need(this.state === State.RUNNING, 'só é possível pausar uma partida rodando');
    this.accumulated += Math.max(0, this.clock() - this.runningSince);
    this.runningSince = -1;
    this.state = State.PAUSED;
    this.events.push({ type: 'PAUSE', team: -1, atMillis: this.accumulated });
  }

  resume() {
    this.tick();
    need(this.state === State.PAUSED, 'só é possível retomar uma partida pausada');
    this.runningSince = this.clock();
    this.state = State.RUNNING;
    this.events.push({ type: 'RESUME', team: -1, atMillis: this.accumulated });
  }

  /** Registra um gol. Aceito com a partida rodando ou pausada. */
  goal(team) {
    this.tick();
    need(this.state === State.RUNNING || this.state === State.PAUSED, 'não é possível marcar gol agora');
    if (team === this.teamA) this.scoreA++;
    else if (team === this.teamB) this.scoreB++;
    else throw new RangeError('time fora da partida: ' + team);
    this.goalStack.push(team);
    this.events.push({ type: 'GOAL', team, atMillis: this.elapsedMillis() });
    const limit = this.rules.goalLimit;
    if (limit > 0 && (this.scoreA >= limit || this.scoreB >= limit)) this.#finish(EndReason.GOALS);
  }

  /**
   * Desfaz o último gol. Se a partida acabou por limite de gols, volta pausada (para
   * corrigir um toque errado). Depois de fim por tempo ou encerramento manual, não desfaz.
   * @returns {boolean} true se desfez algo
   */
  undo() {
    this.tick();
    if (this.goalStack.length === 0) return false;
    if (this.state === State.ENDED && this.endReason !== EndReason.GOALS) return false;
    const team = this.goalStack.pop();
    if (team === this.teamA) this.scoreA--;
    else this.scoreB--;
    this.events.push({ type: 'UNDO_GOAL', team, atMillis: this.elapsedMillis() });
    if (this.state === State.ENDED) {
      this.state = State.PAUSED;
      this.endReason = null;
    }
    return true;
  }

  endManually() {
    this.tick();
    need(this.state === State.RUNNING || this.state === State.PAUSED, 'a partida não está em andamento');
    this.#finish(EndReason.MANUAL);
  }

  /** Time vencedor, ou -1 em caso de empate. Só vale com a partida encerrada. */
  winnerTeam() {
    need(this.state === State.ENDED, 'a partida ainda não acabou');
    if (this.scoreA > this.scoreB) return this.teamA;
    if (this.scoreB > this.scoreA) return this.teamB;
    return -1;
  }

  #finish(reason) {
    if (this.state === State.RUNNING) {
      this.accumulated += Math.max(0, this.clock() - this.runningSince);
      const limit = this.rules.timeLimitMillis;
      if (limit > 0 && this.accumulated > limit) this.accumulated = limit;
    }
    this.runningSince = -1;
    this.state = State.ENDED;
    this.endReason = reason;
    this.events.push({ type: 'END', team: -1, atMillis: this.accumulated });
  }

  toJSON() {
    return {
      teamA: this.teamA,
      teamB: this.teamB,
      state: this.state,
      endReason: this.endReason,
      accumulated: this.accumulated,
      runningSince: this.runningSince,
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      events: this.events.map((e) => ({ ...e })),
      goalStack: this.goalStack.slice(),
    };
  }

  static fromJSON(o, rules, clock) {
    const m = new Match(o.teamA, o.teamB, rules, clock);
    m.state = o.state;
    m.endReason = o.endReason;
    m.accumulated = o.accumulated;
    m.runningSince = o.runningSince;
    m.scoreA = o.scoreA;
    m.scoreB = o.scoreB;
    m.events = o.events.map((e) => ({ ...e }));
    m.goalStack = o.goalStack.slice();
    return m;
  }
}

// ---------------------------------------------------------------- pelada (fila)

/**
 * Uma pelada: times numerados de 0 a n-1, a dupla em campo e a fila de espera.
 * Na primeira partida o time 0 é o mandante (quem estava em campo) e o time 1 o entrante;
 * isso só importa para decidir quem sai num empate.
 */
export class Session {
  constructor(teamCount, rules) {
    if (!(teamCount >= 2)) throw new RangeError('são necessários ao menos 2 times');
    this.teamCount = teamCount;
    this.rules = rules;
    this.queue = [];
    this.streak = new Array(teamCount).fill(0);
    this.history = [];
    this.holder = 0;
    this.challenger = 1;
    for (let t = 2; t < teamCount; t++) this.queue.push(t);
  }

  winStreak(team) {
    return this.streak[team];
  }

  /**
   * Escolhe quais dois times começam jogando. Só vale antes da primeira partida
   * terminar; os demais ficam na fila na ordem em que já estavam.
   */
  setStart(a, b) {
    need(this.history.length === 0, 'só dá para escolher quem começa antes da primeira partida');
    need(Number.isInteger(a) && Number.isInteger(b) && a !== b, 'escolha dois times diferentes');
    need(a >= 0 && b >= 0 && a < this.teamCount && b < this.teamCount, 'time inexistente');
    const rest = [this.holder, this.challenger, ...this.queue].filter((t) => t !== a && t !== b);
    this.holder = a;
    this.challenger = b;
    this.queue = rest;
  }

  newMatch(clock) {
    return new Match(this.holder, this.challenger, this.rules.match, clock);
  }

  /** Registra o resultado de uma partida encerrada e monta a próxima dupla. */
  finish(m) {
    need(m.state === State.ENDED, 'a partida ainda não acabou');
    need(m.teamA === this.holder && m.teamB === this.challenger, 'a partida não é a da dupla atual');
    const winner = m.winnerTeam();
    this.history.push({
      teamA: m.teamA,
      teamB: m.teamB,
      scoreA: m.scoreA,
      scoreB: m.scoreB,
      winner,
      reason: m.endReason,
      elapsedMillis: m.elapsedMillis(),
    });
    if (winner >= 0) this.#applyWin(winner);
    else this.#applyDraw();
  }

  /** Simula o fim da partida sem alterar esta pelada. */
  preview(m) {
    const copy = Session.fromJSON(this.toJSON());
    copy.finish(m);
    return {
      holder: copy.holder,
      challenger: copy.challenger,
      queue: copy.queue.slice(),
      winner: m.winnerTeam(),
      streak: copy.streak.slice(),
    };
  }

  #applyWin(winner) {
    const loser = winner === this.holder ? this.challenger : this.holder;
    this.queue.push(loser);
    this.streak[loser] = 0;
    this.streak[winner]++;
    const limit = this.rules.winStreakLimit;
    if (limit > 0 && this.streak[winner] >= limit) {
      this.streak[winner] = 0;
      this.queue.push(winner);
      this.holder = this.queue.shift();
      this.challenger = this.queue.shift();
    } else {
      this.holder = winner;
      this.challenger = this.queue.shift();
    }
  }

  #applyDraw() {
    this.streak[this.holder] = 0;
    this.streak[this.challenger] = 0;
    const policy = this.rules.drawPolicy;
    const bothLeave =
      policy === DrawPolicy.BOTH_LEAVE || (policy === DrawPolicy.AUTO && this.queue.length >= 2);
    if (bothLeave) {
      this.queue.push(this.holder, this.challenger);
      this.holder = this.queue.shift();
      this.challenger = this.queue.shift();
    } else {
      this.queue.push(this.holder);
      this.holder = this.challenger;
      this.challenger = this.queue.shift();
    }
  }

  toJSON() {
    return {
      teamCount: this.teamCount,
      rules: this.rules.toJSON(),
      holder: this.holder,
      challenger: this.challenger,
      queue: this.queue.slice(),
      streak: this.streak.slice(),
      history: this.history.map((h) => ({ ...h })),
    };
  }

  static fromJSON(o) {
    const s = new Session(o.teamCount, SessionRules.fromJSON(o.rules));
    s.holder = o.holder;
    s.challenger = o.challenger;
    s.queue = o.queue.slice();
    s.streak = o.streak.slice();
    s.history = o.history.map((h) => ({ ...h }));
    return s;
  }
}

// ---------------------------------------------------------------- sorteio

/**
 * Sorteio ao vivo por cotas: cada time tem um número fixo de vagas, as vagas são
 * embaralhadas uma vez e cada pessoa que se identifica leva a próxima. Assim os times
 * fecham no tamanho certo e ninguém fica sem vaga por azar no fim.
 */
export class LiveDraw {
  constructor(quotas, rng = Math.random) {
    this.quotas = quotas.slice();
    this.used = quotas.map(() => 0);
    this.slots = [];
    this.next = 0;
    /** @type {Map<string, number>} */
    this.assigned = new Map();
    this.log = [];
    quotas.forEach((q, team) => {
      if (!(q >= 0)) throw new RangeError('cota negativa');
      for (let i = 0; i < q; i++) this.slots.push(team);
    });
    shuffle(this.slots, rng);
  }

  /**
   * Quantas vagas cada time terá. Divide `players` o mais igualmente possível; os times
   * que ficam com uma vaga a mais são escolhidos ao acaso. Se `maxPerTeam` > 0, limita o
   * tamanho de cada time e o excesso de pessoas fica sem vaga.
   */
  static evenQuotas(players, teams, maxPerTeam, rng = Math.random) {
    if (!(teams >= 2)) throw new RangeError('são necessários ao menos 2 times');
    if (!(players >= 0)) throw new RangeError('número de jogadores negativo');
    let total = players;
    if (maxPerTeam > 0) total = Math.min(total, teams * maxPerTeam);
    const base = Math.floor(total / teams);
    const extra = total % teams;
    const quotas = new Array(teams).fill(base);
    const order = shuffle([...quotas.keys()], rng);
    for (let i = 0; i < extra; i++) quotas[order[i]]++;
    return quotas;
  }

  /**
   * Revela a próxima vaga. Sem `playerId` (modo cor) não guarda quem é a pessoa.
   * Devolve -1 se as vagas acabaram. Uma pessoa sorteia uma vez só.
   */
  reveal(playerId = null) {
    if (playerId != null && this.assigned.has(playerId)) {
      throw new Error('esse jogador já foi sorteado');
    }
    if (this.next >= this.slots.length) return -1;
    const team = this.slots[this.next++];
    this.used[team]++;
    if (playerId != null) this.assigned.set(playerId, team);
    this.log.push({ playerId, team });
    return team;
  }

  /** Desfaz o último sorteio, devolvendo a vaga. Devolve o que foi desfeito, ou null. */
  undoLast() {
    const last = this.log.pop();
    if (!last) return null;
    this.next--;
    this.used[last.team]--;
    if (last.playerId != null) this.assigned.delete(last.playerId);
    return last;
  }

  /** Troca um jogador já sorteado de time (ajuste manual). */
  move(playerId, team) {
    need(this.assigned.has(playerId), 'jogador ainda não foi sorteado');
    if (!(team >= 0 && team < this.quotas.length)) throw new RangeError('time inexistente');
    this.assigned.set(playerId, team);
  }

  teamOf(playerId) {
    const t = this.assigned.get(playerId);
    return t === undefined ? -1 : t;
  }

  hasDrawn(playerId) {
    return this.assigned.has(playerId);
  }

  /** Ids dos jogadores de um time (só no modo nomes). */
  members(team) {
    return [...this.assigned.entries()].filter(([, t]) => t === team).map(([id]) => id);
  }

  /** Quantas pessoas já foram sorteadas para cada time (vale também no modo cor). */
  counts() {
    return this.used.slice();
  }

  drawnTotal() {
    return this.next;
  }

  totalSlots() {
    return this.slots.length;
  }

  remaining(team) {
    return this.quotas[team] - this.used[team];
  }

  remainingTotal() {
    return this.slots.length - this.next;
  }

  toJSON() {
    return {
      quotas: this.quotas.slice(),
      used: this.used.slice(),
      slots: this.slots.slice(),
      next: this.next,
      assigned: [...this.assigned.entries()],
      log: this.log.map((l) => ({ ...l })),
    };
  }

  static fromJSON(o) {
    const d = new LiveDraw(o.quotas.map(() => 0));
    d.quotas = o.quotas.slice();
    d.used = o.used.slice();
    d.slots = o.slots.slice();
    d.next = o.next;
    d.assigned = new Map(o.assigned);
    d.log = o.log.map((l) => ({ ...l }));
    return d;
  }
}

// ---------------------------------------------------------------- nomes (voz)

/** Minúsculas, sem acentos, só letras e números separados por um espaço. */
export function normalize(s) {
  return String(s)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

export const Kind = Object.freeze({
  /** Um único jogador bate exatamente com o que foi dito. */
  EXACT: 'EXACT',
  /** Um jogador se destaca claramente dos demais. */
  CONFIDENT: 'CONFIDENT',
  /** Dúvida: mostrar as opções para a pessoa escolher. */
  AMBIGUOUS: 'AMBIGUOUS',
  /** Nada parecido: cair na lista. */
  NONE: 'NONE',
});

// Limiares são pontos de partida: NÃO foram calibrados com fala real em campo.
const EXACT_SCORE = 0.999;
const FIRST_NAME_FACTOR = 0.95;
const CONFIDENT_MIN = 0.75;
const CONFIDENT_GAP = 0.15;
const AMBIGUOUS_MIN = 0.6;
const MAX_OPTIONS = 3;
/** Cada alternativa seguinte do reconhecedor vale um pouco menos que a anterior. */
const ALTERNATIVE_DECAY = 0.97;

function keyScore(heard, key) {
  if (!key) return 0;
  if (heard === key) return 1;
  const max = Math.max(heard.length, key.length);
  return 1 - levenshtein(heard, key) / max;
}

function scorePlayer(heard, player) {
  const name = normalize(player.name);
  let best = keyScore(heard, name);
  const tokens = name.split(' ');
  if (tokens.length > 1) best = Math.max(best, FIRST_NAME_FACTOR * keyScore(heard, tokens[0]));
  for (const alias of player.aliases || []) best = Math.max(best, keyScore(heard, normalize(alias)));
  return best;
}

export class NameMatcher {
  constructor(players) {
    this.players = players.slice();
  }

  /** `heard`: o texto reconhecido. `excluded`: ids que já sortearam (Set ou lista). */
  match(heard, excluded = null) {
    return this.matchAny([heard], excluded);
  }

  /**
   * Usa todas as alternativas que o reconhecedor devolveu (da mais para a menos provável).
   * @returns {{kind: string, candidates: {player: object, score: number}[]}}
   */
  matchAny(heardList, excluded = null) {
    const skip = excluded ? new Set(excluded) : null;
    const best = new Map();
    heardList.forEach((heard, i) => {
      const h = normalize(heard);
      if (!h) return;
      const decay = Math.pow(ALTERNATIVE_DECAY, i);
      for (const p of this.players) {
        if (skip && skip.has(p.id)) continue;
        const score = scorePlayer(h, p) * decay;
        const known = best.get(p.id);
        if (!known || score > known.score) best.set(p.id, { player: p, score });
      }
    });
    const all = [...best.values()].sort((a, b) => b.score - a.score);
    if (all.length === 0 || all[0].score < AMBIGUOUS_MIN) return { kind: Kind.NONE, candidates: [] };

    const top = all[0];
    const second = all.length > 1 ? all[1].score : 0;
    if (top.score >= EXACT_SCORE && second < EXACT_SCORE) return { kind: Kind.EXACT, candidates: [top] };
    if (top.score >= CONFIDENT_MIN && top.score - second >= CONFIDENT_GAP) {
      return { kind: Kind.CONFIDENT, candidates: [top] };
    }
    return {
      kind: Kind.AMBIGUOUS,
      candidates: all.filter((c) => c.score >= AMBIGUOUS_MIN).slice(0, MAX_OPTIONS),
    };
  }
}
