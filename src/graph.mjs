// The ticket graph: which ticket waits for which, what can start now, and in what
// order. Pure functions over plain objects, so the daemon, the board and the
// tests all read the same answers.

const FINISHED = new Set(["done"]);
const DEAD = new Set(["failed", "cancelled"]);

// Returns null when `needs` form a valid graph, else a sentence saying what is wrong.
export function graphProblem(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const n of t.needs ?? []) {
      if (n === t.id) return `${t.id} needs itself`;
      if (!byId.has(n)) return `${t.id} needs ${n}, which does not exist`;
    }
  }
  const seen = new Map(); // id -> 1 visiting, 2 done
  const walk = (id, trail) => {
    if (seen.get(id) === 2) return null;
    if (seen.get(id) === 1) return `dependency loop: ${[...trail.slice(trail.indexOf(id)), id].join(" → ")}`;
    seen.set(id, 1);
    for (const n of byId.get(id).needs ?? []) {
      const bad = walk(n, [...trail, id]);
      if (bad) return bad;
    }
    seen.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    const bad = walk(t.id, []);
    if (bad) return bad;
  }
  return null;
}

// Column of each ticket when the graph is drawn left to right: one more than the
// deepest thing it needs. Needs outside `tickets` (another goal) count as column 0.
export function ranks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rank = new Map();
  const walk = (id, guard) => {
    if (rank.has(id)) return rank.get(id);
    if (guard.has(id)) return 0; // a loop slipped in; do not hang the board over it
    guard.add(id);
    const needs = (byId.get(id)?.needs ?? []).filter((n) => byId.has(n));
    const r = needs.length ? 1 + Math.max(...needs.map((n) => walk(n, guard))) : 0;
    rank.set(id, r);
    return r;
  };
  for (const t of tasks) walk(t.id, new Set());
  return rank;
}

// id -> Set of every ticket that (transitively) waits on it.
export function dependentsOf(tasks) {
  const direct = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const n of t.needs ?? []) direct.get(n)?.push(t.id);
  const out = new Map();
  const walk = (id) => {
    if (out.has(id)) return out.get(id);
    const set = new Set();
    out.set(id, set); // set early: a loop then ends instead of recursing forever
    for (const d of direct.get(id) ?? []) {
      set.add(d);
      for (const x of walk(d)) set.add(x);
    }
    return set;
  };
  for (const t of tasks) walk(t.id);
  return out;
}

export function unmetNeeds(task, byId) {
  return (task.needs ?? []).filter((n) => !FINISHED.has(byId.get(n)?.status));
}

export function deadNeeds(task, byId) {
  return (task.needs ?? []).filter((n) => DEAD.has(byId.get(n)?.status));
}

// What the board calls a ticket. `status` is what the daemon stores; this adds
// the parts that depend on other tickets and on open asks.
export function displayState(task, byId, openAsks, goal) {
  if (task.status === "todo") {
    if (goal && goal.status === "paused") return "paused";
    if (goal && goal.status === "planning") return "waiting";
    if (deadNeeds(task, byId).length) return "stuck";
    return unmetNeeds(task, byId).length ? "waiting" : "ready";
  }
  if (task.status === "blocked") {
    const mine = openAsks.filter((a) => a.task === task.id);
    return mine.some((a) => a.to === "chef") ? "needs_you" : "with_sous";
  }
  return task.status; // running | review | done | failed | paused | cancelled
}

// Ready tickets in the order they should start: explicit priority first, then the
// one that unblocks the most other work, then the oldest.
export function startOrder(tasks, byId, goals) {
  const waitingOn = dependentsOf(tasks);
  const weight = (t) => [...(waitingOn.get(t.id) ?? [])].filter((id) => !FINISHED.has(byId.get(id)?.status) && !DEAD.has(byId.get(id)?.status)).length;
  return tasks
    .filter((t) => t.status === "todo" && goals[t.goal]?.status === "active" && !unmetNeeds(t, byId).length)
    .map((t) => ({ t, w: weight(t) }))
    .sort((a, b) => (b.t.priority ?? 0) - (a.t.priority ?? 0) || b.w - a.w || a.t.createdAt - b.t.createdAt || a.t.id.localeCompare(b.t.id, undefined, { numeric: true }))
    .map((x) => x.t);
}

// How much work an ask is holding up: its own ticket plus everything waiting behind it.
export function heldUpBy(taskId, tasks, byId) {
  if (!taskId || !byId.has(taskId)) return 0;
  const waitingOn = dependentsOf(tasks).get(taskId) ?? new Set();
  return 1 + [...waitingOn].filter((id) => !FINISHED.has(byId.get(id)?.status) && !DEAD.has(byId.get(id)?.status)).length;
}
