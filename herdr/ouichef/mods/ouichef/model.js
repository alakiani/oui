// What the Oui Chef mod knows, apart from how to draw it. No Herdr imports,
// so this file runs under plain Node and is tested there.

export const DEFAULT_HOME = ".ouichef";
export const POLL_MS = 2000;
export const TIMEOUT_MS = 4000; // Herdr's fetch has no timeout of its own
export const WIDE = 760; // from this width the view shows the flow beside the inbox

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const text = (v, max = 600) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const id = (v) => (typeof v === "string" && /^[A-Z]\d{1,7}$/.test(v) ? v : "");
const ids = (v) => (Array.isArray(v) ? v.map(id).filter(Boolean) : []);
const strings = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.slice(0, max)) : []);

// A port is a whole number in range. A url is built from it, so it is never taken as text.
export const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// daemon.json -> where the daemon is and how to run oui. Null when it is unreadable.
export function parseDaemon(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(d) || !validPort(d.port)) return null;
  return {
    port: d.port,
    token: typeof d.token === "string" && /^[a-f0-9]{16,128}$/.test(d.token) ? d.token : null,
    node: typeof d.node === "string" ? d.node : null,
    oui: typeof d.oui === "string" ? d.oui : null,
    running: Number.isInteger(d.pid),
  };
}

// Any local process could answer on the port, so a reply is rebuilt into the
// shapes the view draws: wrong types become empty, entries without an id go.
export function clean(b) {
  if (!isObj(b) || !Array.isArray(b.tasks)) return null;
  const c = isObj(b.counts) ? b.counts : {};
  return {
    rev: num(b.rev),
    now: num(b.now),
    service: { on: b.service?.on !== false, running: num(b.service?.running), max: num(b.service?.max) },
    counts: { needsYou: num(c.needsYou), withSous: num(c.withSous), running: num(c.running), review: num(c.review), ready: num(c.ready), waiting: num(c.waiting), done: num(c.done), failed: num(c.failed) },
    asks: list(b.asks)
      .map((a) => ({
        id: id(a.id),
        kind: text(a.kind, 20),
        task: id(a.task),
        goal: id(a.goal),
        title: text(a.title, 240),
        body: text(a.body, 700),
        command: text(a.command, 400),
        options: strings(a.options, 160).slice(0, 6),
        pick: text(a.pick, 160),
        undo: list(a.undo).map((u) => text(u.summary, 200)).filter(Boolean),
        viaSous: Boolean(a.viaSous),
        holds: num(a.holds),
        createdAt: num(a.createdAt),
      }))
      .filter((a) => a.id),
    goals: list(b.goals)
      .map((g) => ({ id: id(g.id), title: text(g.title, 120), project: text(g.project, 40), status: text(g.status, 20), done: num(g.done), total: num(g.total), landed: Boolean(g.landed), pr: Boolean(g.pr) }))
      .filter((g) => g.id),
    tasks: list(b.tasks)
      .map((t) => ({ id: id(t.id), goal: id(t.goal), title: text(t.title, 120), kind: text(t.kind, 12), state: text(t.state, 20), line: text(t.line, 160), needs: ids(t.needs), waitingOn: ids(t.waitingOn), rank: Math.max(0, Math.min(200, Math.round(num(t.rank)))), next: num(t.next), attempt: num(t.attempt), activeAt: num(t.activeAt), finishedAt: num(t.finishedAt) }))
      .filter((t) => t.id),
    feed: list(b.feed).map((e) => ({ id: text(e.id, 12), ts: num(e.ts), type: text(e.type, 16), from: text(e.from, 24), to: text(e.to, 24), task: id(e.task), text: text(e.text, 300) })),
  };
}

export const ago = (ts, now) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

const n = (x) => Number(String(x).slice(1));
const byId = (a, b) => n(a.id) - n(b.id);

// The list a narrow panel shows, top to bottom: what needs you, then what is
// moving, then what comes next and in what order.
export function sections(b) {
  const t = b.tasks;
  const of = (...states) => t.filter((x) => states.includes(x.state));
  return {
    asks: b.asks,
    running: of("running", "blocked").sort((a, c) => c.activeAt - a.activeAt),
    review: of("review", "with_sous").sort(byId),
    next: of("ready").sort((a, c) => (a.next || 1e9) - (c.next || 1e9)),
    waiting: of("waiting", "stuck", "paused").sort((a, c) => a.rank - c.rank || byId(a, c)),
    failed: of("failed").sort(byId),
    done: of("done").sort((a, c) => c.finishedAt - a.finishedAt),
  };
}

export const STATE = { needs_you: "At the pass", running: "Running", blocked: "Resuming", review: "In review", with_sous: "With sous chef", ready: "Next up", waiting: "Waiting", stuck: "Stuck upstream", done: "Done", failed: "Failed", paused: "Paused" };
export const KIND = { question: "QUESTION", decision: "DECISION", access: "ACCESS", approval: "APPROVE", land: "LAND", stuck: "STUCK" };

export const CARD_H = 74;
export const ROW_GAP = 10;

// Each goal as a lane: columns by what must come first, sized to fit `width`.
// -> [{ goal, width, height, cardW, cards: [{ ticket, x, y }], edges: [{ x1, y1, x2, y2, met }] }]
export function lanes(b, width) {
  return b.goals
    .filter((g) => g.status !== "cancelled")
    .map((goal) => {
      const mine = b.tasks.filter((t) => t.goal === goal.id);
      const maxRank = Math.max(0, ...mine.map((t) => t.rank));
      const gap = 28;
      const step = Math.max(150, Math.min(250, Math.floor((width + gap) / (maxRank + 1))));
      const cardW = step - gap;
      const cols = new Map();
      for (const t of mine) cols.set(t.rank, [...(cols.get(t.rank) ?? []), t]);
      const pos = {};
      let height = 0;
      for (const rank of [...cols.keys()].sort((a, c) => a - c)) {
        const want = (t) => {
          const ys = t.needs.filter((x) => pos[x]).map((x) => pos[x].y);
          return ys.length ? ys.reduce((a, y) => a + y, 0) / ys.length : null;
        };
        const col = cols.get(rank).map((t) => ({ t, w: want(t) })).sort((a, c) => (a.w ?? 1e9) - (c.w ?? 1e9) || byId(a.t, c.t));
        let y = 0;
        for (const { t, w } of col) {
          const top = Math.max(y, w ?? y);
          pos[t.id] = { x: rank * step, y: top };
          y = top + CARD_H + ROW_GAP;
        }
        height = Math.max(height, y - ROW_GAP);
      }
      const state = Object.fromEntries(mine.map((t) => [t.id, t.state]));
      const edges = mine.flatMap((t) => t.needs.filter((x) => pos[x]).map((x) => ({ x1: pos[x].x + cardW, y1: pos[x].y + CARD_H / 2, x2: pos[t.id].x, y2: pos[t.id].y + CARD_H / 2, met: state[x] === "done" })));
      return { goal, width: (maxRank + 1) * step - gap, height: Math.max(0, height), cardW, cards: mine.map((t) => ({ task: t, ...pos[t.id] })), edges };
    });
}

// The daemon takes chef actions over GET too, because that is the one kind
// of request a mod is known to be able to make. The token rides in the query.
export function actionUrl(daemon, method, params = {}) {
  if (!daemon || !validPort(daemon.port) || !daemon.token) return null;
  const q = Object.entries({ m: method, t: daemon.token, ...params })
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `http://127.0.0.1:${daemon.port}/act?${q}`;
}

export const boardUrl = (daemon) => (daemon && validPort(daemon.port) ? `http://127.0.0.1:${daemon.port}/api/board` : null);
