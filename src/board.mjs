// One snapshot that both boards (the web page and the Herdr mod) draw from.
// Everything the chef needs at a glance, and nothing they would have to dig for.

import { displayState, deadNeeds, heldUpBy, ranks, startOrder, unmetNeeds } from "./graph.mjs";
import { clip } from "./kitchen.mjs";

const FEED_TYPES = new Set(["msg", "ask", "answer", "approval", "report", "review", "guard", "plan", "goal", "system", "note"]);
const REVIEW_STAGE = { verify: "running the checks", review: "inspector is reviewing", integrate: "merging into the goal branch" };

function line(t, state, byId, open, goal) {
  if (state === "waiting" && goal?.status === "proposed") return "when you say to cook";
  if (state === "running") return t.note ?? t.lastTool?.detail ?? "starting…";
  // A question's title is the question itself, so its line says what is being waited for.
  if (state === "needs_you" && t.kind === "decide") return `your call${t.pick ? `; the plan would pick: ${t.pick}` : ""}`;
  if (state === "needs_you") return open.find((a) => a.task === t.id && a.to === "chef")?.title ?? "waiting for you";
  if (state === "with_sous") return `sous chef is answering: ${open.find((a) => a.task === t.id)?.title ?? "a question"}`;
  if (state === "waiting") return `after ${unmetNeeds(t, byId).join(", ")}`;
  if (state === "stuck") return `${deadNeeds(t, byId).join(", ")} did not finish`;
  if (state === "ready") return "next up";
  if (state === "review") return REVIEW_STAGE[t.reviewStage] ?? "being checked";
  if (state === "done") return clip(t.report?.summary ?? "done", 140);
  if (state === "failed") return clip(t.failure ?? "failed", 140);
  if (state === "blocked") return "resuming…";
  return state;
}

export function buildBoard(kitchen, running = new Map()) {
  const s = kitchen.state;
  const tasks = Object.values(s.tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = kitchen.openAsks();
  const order = startOrder(tasks, byId, s.goals).map((t) => t.id);

  const goals = Object.values(s.goals).map((g) => {
    const mine = tasks.filter((t) => t.goal === g.id && t.status !== "cancelled");
    const rank = ranks(mine);
    return {
      id: g.id,
      title: g.title,
      project: g.project,
      status: g.status,
      done: mine.filter((t) => t.status === "done").length,
      total: mine.length,
      branch: g.branch ?? null,
      pr: g.pr ?? null,
      landed: g.landedAt ?? null,
      createdAt: g.createdAt,
      rank: Object.fromEntries(rank),
    };
  });
  const rankOf = Object.assign({}, ...goals.map((g) => g.rank));

  const cards = tasks
    .filter((t) => t.status !== "cancelled")
    .map((t) => {
      const state = displayState(t, byId, open, s.goals[t.goal]);
      return {
        id: t.id,
        goal: t.goal,
        project: t.project,
        title: t.title,
        kind: t.kind,
        state,
        line: clip(line(t, state, byId, open, s.goals[t.goal]), 160),
        needs: t.needs,
        waitingOn: t.status === "todo" ? unmetNeeds(t, byId) : [],
        rank: rankOf[t.id] ?? 0,
        next: order.indexOf(t.id) + 1 || null, // 1 = the next ticket to start
        asks: open.filter((a) => a.task === t.id).map((a) => a.id),
        attempt: t.attempt,
        turns: t.turns,
        cost: t.cost ? Math.round(t.cost * 100) / 100 : 0,
        live: running.has(t.id),
        activeAt: t.activeAt ?? t.startedAt ?? null,
        startedAt: t.startedAt ?? null,
        finishedAt: t.finishedAt ?? null,
        pr: t.report?.pr ?? null,
        branch: t.branch ?? null,
        unreviewed: Boolean(t.unreviewed),
        terminal: t.terminal && !t.terminal.gone ? { backend: t.terminal.backend, handle: t.terminal.handle } : null,
      };
    });

  const asks = open
    .filter((a) => a.to === "chef")
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      task: a.task ?? a.about ?? null, // a message names the ticket it came from
      taskTitle: byId.get(a.task ?? a.about)?.title ?? null,
      goal: a.goal,
      goalTitle: a.goal ? s.goals[a.goal]?.title ?? null : null,
      from: a.from,
      title: a.title,
      body: a.body,
      options: a.options,
      pick: a.pick,
      command: a.command,
      rule: a.rule,
      undo: a.undo,
      viaSous: Boolean(a.escalatedBy),
      createdAt: a.createdAt,
      // Tickets that cannot move until this is answered. A question in the plan is not work itself, so it does not count.
      // A plan waiting for the chef's go holds every ticket in it.
      holds: a.kind === "plan" ? tasks.filter((t) => t.goal === a.goal && t.status === "todo" && t.kind !== "decide").length : heldUpBy(a.task, tasks, byId) - (byId.get(a.task)?.kind === "decide" ? 1 : 0),
    }))
    .sort((a, b) => b.holds - a.holds || a.createdAt - b.createdAt);

  const count = (state) => cards.filter((c) => c.state === state).length;
  return {
    rev: s.rev,
    now: Date.now(),
    service: { on: s.service.on, running: running.size, max: kitchen.config.maxCooks, harness: kitchen.config.harness, sessions: kitchen.expo?.backend?.name ?? "none" },
    counts: {
      needsYou: asks.length,
      withSous: open.filter((a) => a.to === "sous").length,
      running: count("running"),
      review: count("review"),
      ready: count("ready"),
      waiting: count("waiting") + count("stuck"),
      done: count("done"),
      failed: count("failed"),
      paused: count("paused"),
    },
    asks,
    // Unfinished goals first, oldest first: a goal keeps its place on the board while it runs.
    goals: goals.map(({ rank, ...g }) => g).sort((a, b) => (a.status === "done") - (b.status === "done") || a.createdAt - b.createdAt || a.id.localeCompare(b.id, undefined, { numeric: true })),
    tasks: cards,
    next: order,
    feed: kitchen.feed.filter((e) => FEED_TYPES.has(e.type)).slice(-80),
    projects: Object.values(s.projects).map((p) => ({ id: p.id, name: p.name, path: p.path, landing: p.landing, merge: p.merge })),
  };
}

// A few lines for a terminal or a sous chef's context: only what needs someone.
export function digest(board) {
  const out = [];
  const c = board.counts;
  out.push(`${c.needsYou} need you · ${c.running} running · ${c.review} in review · ${c.ready} ready · ${c.waiting} waiting · ${c.done} done${c.failed ? ` · ${c.failed} failed` : ""}${board.service.on ? "" : " · SERVICE PAUSED"}`);
  if (board.asks.length) {
    out.push("", "ON THE PASS");
    for (const a of board.asks) out.push(`  ${a.id} [${a.kind}] ${a.task ?? a.goal ?? ""} ${a.title}${a.holds > 1 ? `  (holds up ${a.holds} tickets)` : ""}${a.command ? `\n      $ ${clip(a.command, 200)}` : ""}${a.options?.length ? `\n      options: ${a.options.join(" | ")}${a.pick ? `   (asker would pick: ${a.pick})` : ""}` : ""}`);
  }
  for (const g of board.goals.filter((x) => x.status !== "done" && x.status !== "cancelled")) {
    out.push("", `${g.id} ${g.title}  [${g.project}] ${g.done}/${g.total}${g.status !== "active" ? `  (${{ proposed: "the plan is waiting for your go", unplanned: "no plan yet: needs you" }[g.status] ?? g.status})` : ""}`);
    const mine = board.tasks.filter((t) => t.goal === g.id).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const t of mine) out.push(`  ${t.id.padEnd(4)} ${({ needs_you: "at the pass", with_sous: "with sous" }[t.state] ?? t.state).padEnd(11)} ${clip(t.title, 60)}${t.state === "done" ? "" : ` — ${clip(t.line, 90)}`}`);
  }
  return out.join("\n");
}
