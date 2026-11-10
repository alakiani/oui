// The kitchen: all of Oui Chef's state and the rules for changing it. One
// process (the daemon) owns it, so there is exactly one writer. Everything an
// agent or the chef does arrives here as a method call with a `who`.
//
// It starts no processes. The expediter (expediter.mjs) watches the kitchen and
// does the running.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { P, appendLine, ensureDir, home, loadConfig, readJson, writeJsonAtomic } from "./paths.mjs";
import { loadPolicy } from "./guard/policy.mjs";
import { RULES, TIER_NAME, tierOf } from "./guard/rules.mjs";
import { renderUndo, runUndo } from "./guard/undo.mjs";
import { graphProblem } from "./graph.mjs";

const now = () => Date.now();
export const clip = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
export const slug = (s, n = 32) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, n)
    .replace(/-+$/, "") || "x";

function tailJsonl(file, max) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-max).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const fresh = () => ({ version: 1, rev: 0, seq: { goal: 0, ticket: 0, ask: 0, action: 0, event: 0 }, service: { on: true }, projects: {}, goals: {}, tasks: {}, asks: {}, grants: [] });

export class Fail extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Kitchen {
  constructor() {
    ensureDir(home());
    this.config = loadConfig();
    this.policy = loadPolicy();
    this.state = { ...fresh(), ...(readJson(P.state()) ?? {}) };
    this.feed = tailJsonl(P.events(), 400);
    this.ledger = this.#loadLedger();
    this.secret = crypto.randomBytes(24).toString("hex");
    this.chefToken = crypto.randomBytes(24).toString("hex");
    this.waiters = new Set();
    this.onChange = () => {};
    this.expo = null;
    this.#recover();
  }

  // ---- plumbing

  #loadLedger() {
    const byId = new Map();
    for (const line of tailJsonl(P.ledger(), 4000)) {
      if (line.patch) Object.assign(byId.get(line.patch) ?? {}, line.set);
      else if (line.id) byId.set(line.id, line);
    }
    return [...byId.values()];
  }

  // A daemon that died mid-flight left tickets marked as running with nobody running them.
  #recover() {
    for (const t of Object.values(this.state.tasks)) {
      if (t.status === "running") {
        t.status = "blocked";
        t.inbox = [...(t.inbox ?? []), { kind: "system", text: "Oui Chef restarted while you were working. Check where you left off (git status, your last notes) and carry on." }];
      } else if (t.status === "review") t.reviewStage = null;
    }
    for (const g of Object.values(this.state.goals)) if (g.status === "planning") g.planTried = false;
  }

  save() {
    writeJsonAtomic(P.state(), this.state);
  }

  changed() {
    this.state.rev++;
    this.save();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    this.onChange();
  }

  nextId(kind, prefix) {
    this.state.seq[kind] = (this.state.seq[kind] ?? 0) + 1;
    return `${prefix}${this.state.seq[kind]}`;
  }

  // The feed: who said what to whom. This is what "comms" on the board shows.
  emit(event) {
    const full = { id: this.nextId("event", "E"), ts: now(), ...event, text: clip(event.text, 600) };
    this.feed.push(full);
    if (this.feed.length > 500) this.feed.splice(0, this.feed.length - 400);
    appendLine(P.events(), full);
    return full;
  }

  token(role, subject) {
    const mac = crypto.createHmac("sha256", this.secret).update(`${role}.${subject}`).digest("hex").slice(0, 32);
    return `${role}.${subject}.${mac}`;
  }

  // -> { role, ticket } or null. The chef's token is random; agents carry a signed one.
  identify(token) {
    if (!token) return null;
    if (token === this.chefToken) return { role: "chef" };
    const [role, subject, mac] = String(token).split(".");
    if (!role || !subject || !mac || this.token(role, subject) !== token) return null;
    return { role, task: role === "cook" ? subject : this.state.tasks[subject] ? subject : null, subject };
  }

  task(id) {
    const t = this.state.tasks[id];
    if (!t) throw new Fail(`No ticket ${id}`, 404);
    return t;
  }

  goal(id) {
    const g = this.state.goals[id];
    if (!g) throw new Fail(`No goal ${id}`, 404);
    return g;
  }

  ask(id) {
    const a = this.state.asks[id];
    if (!a) throw new Fail(`No ask ${id}`, 404);
    return a;
  }

  openAsks(taskId) {
    return Object.values(this.state.asks).filter((a) => a.status === "open" && (taskId == null || a.task === taskId));
  }

  taskDir(id) {
    return ensureDir(P.task(id));
  }

  // ---- projects

  projectAdd(p) {
    if (!p?.path) throw new Fail("A project needs a path");
    const dir = path.resolve(p.path);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Fail(`${dir} is not a directory`);
    const id = slug(p.name ?? path.basename(dir), 24);
    const existing = this.state.projects[id];
    if (existing && existing.path !== dir && !p.replace) throw new Fail(`A project named ${id} already points at ${existing.path}. Pass --name to add this one under another name.`);
    const git = (args) => {
      try {
        return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
      } catch {
        return "";
      }
    };
    const isGit = git(["rev-parse", "--is-inside-work-tree"]) === "true";
    const hasRemote = isGit && Boolean(git(["remote", "get-url", "origin"]));
    const project = {
      id,
      name: p.name ?? path.basename(dir),
      path: dir,
      git: isGit,
      base: p.base ?? (isGit ? git(["rev-parse", "--abbrev-ref", "HEAD"]) || "main" : null),
      landing: p.landing ?? existing?.landing ?? (hasRemote ? "pr" : "local"), // how a finished goal reaches the base branch
      merge: p.merge ?? existing?.merge ?? "ask", // "ask": the chef approves each landing · "auto": lands when green
      verify: p.verify ?? existing?.verify ?? [], // commands every ticket in this project must pass
      maxCooks: p.maxCooks ?? existing?.maxCooks ?? 3,
      protected: p.protected ?? existing?.protected ?? [],
      addedAt: existing?.addedAt ?? now(),
    };
    if (!["local", "pr"].includes(project.landing)) throw new Fail("landing is local or pr");
    if (!["ask", "auto"].includes(project.merge)) throw new Fail("merge is ask or auto");
    this.state.projects[id] = project;
    this.changed();
    return project;
  }

  // A project given by id, by path, or left out when there is only one.
  resolveProject(ref) {
    const all = Object.values(this.state.projects);
    if (!ref) {
      if (all.length === 1) return all[0];
      throw new Fail(all.length ? `Which project? ${all.map((p) => p.id).join(", ")}` : "No projects yet. Add one: oui project add <path>");
    }
    if (this.state.projects[ref]) return this.state.projects[ref];
    const dir = path.resolve(ref);
    const byPath = all.find((p) => p.path === dir);
    if (byPath) return byPath;
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return this.projectAdd({ path: dir });
    throw new Fail(`No project ${ref}. Known: ${all.map((p) => p.id).join(", ") || "none"}`);
  }

  // ---- goals and tickets

  #newTask(goal, spec, by) {
    const id = this.nextId("ticket", "T");
    const kind = ["build", "ops", "scout", "land"].includes(spec.kind) ? spec.kind : "build";
    this.state.tasks[id] = {
      id,
      goal: goal.id,
      project: goal.project,
      key: spec.key ?? null,
      title: clip(spec.title, 120),
      brief: String(spec.brief ?? spec.title ?? "").trim(),
      accept: (spec.accept ?? []).map((a) => clip(a, 300)),
      kind, // build: changes code in a worktree · ops: acts on systems · scout: investigates and reports
      needs: [],
      verify: spec.verify ?? [],
      priority: spec.priority ?? 0,
      status: "todo",
      attempt: 0,
      nudges: 0,
      errors: 0,
      turns: 0,
      cost: 0,
      inbox: [],
      by,
      createdAt: now(),
    };
    return this.state.tasks[id];
  }

  // Lay down a goal and its tickets in one go. `needs` may name keys in this plan or existing ticket ids.
  plan(input, who) {
    const specs = input?.tickets ?? input?.tasks ?? [];
    if (!specs.length) throw new Fail("A plan needs at least one ticket");
    let goal;
    if (input.goalId) {
      goal = this.goal(input.goalId);
      if (input.goal?.title) goal.title = clip(input.goal.title, 120);
    } else {
      if (!input.goal?.title) throw new Fail("A plan needs goal.title");
      const project = this.resolveProject(input.goal.project);
      goal = { id: this.nextId("goal", "G"), title: clip(input.goal.title, 120), detail: String(input.goal.detail ?? "").trim(), project: project.id, status: "active", createdAt: now(), by: who.role };
      this.state.goals[goal.id] = goal;
    }
    const keys = new Map();
    for (const s of specs) {
      if (!s.title) throw new Fail("Every ticket needs a title");
      if (s.key && keys.has(s.key)) throw new Fail(`Two tickets share the key ${s.key}`);
    }
    const before = { tasks: { ...this.state.tasks }, seq: { ...this.state.seq }, goals: { ...this.state.goals } };
    try {
      const made = specs.map((s) => {
        const t = this.#newTask(goal, s, who.role === "cook" ? `cook:${who.task}` : who.role);
        if (s.key) keys.set(s.key, t.id);
        return [t, s];
      });
      for (const [t, s] of made) {
        t.needs = [...new Set((s.needs ?? []).map((n) => keys.get(n) ?? n))];
      }
      const problem = graphProblem(Object.values(this.state.tasks));
      if (problem) throw new Fail(`This plan does not hold together: ${problem}`);
      if (goal.status === "planning") goal.status = "active";
      this.emit({ type: "plan", from: who.role === "chef" ? "chef" : "sous", to: "board", goal: goal.id, text: `Planned ${goal.id} “${goal.title}”: ${made.length} ticket${made.length === 1 ? "" : "s"}` });
      this.changed();
      return { goal: goal.id, tasks: made.map(([t]) => ({ id: t.id, key: t.key, title: t.title, needs: t.needs })) };
    } catch (e) {
      Object.assign(this.state, { tasks: before.tasks, goals: input.goalId ? this.state.goals : before.goals });
      this.state.seq = before.seq;
      throw e;
    }
  }

  // A goal in the chef's words. The sous chef turns it into tickets.
  go({ text, project, title }, who) {
    if (!String(text ?? "").trim()) throw new Fail("Say what you want done");
    const proj = this.resolveProject(project);
    const goal = { id: this.nextId("goal", "G"), title: clip(title ?? String(text).split("\n")[0], 120), detail: String(text).trim(), project: proj.id, status: "planning", createdAt: now(), by: who.role };
    this.state.goals[goal.id] = goal;
    this.emit({ type: "goal", from: "chef", to: "sous", goal: goal.id, text: goal.detail });
    this.changed();
    return { goal: goal.id, project: proj.id };
  }

  taskAdd(spec, who) {
    const goal = this.goal(spec.goal ?? (who.task ? this.task(who.task).goal : null));
    const before = { tasks: { ...this.state.tasks }, seq: { ...this.state.seq } };
    const t = this.#newTask(goal, spec, who.role === "cook" ? `cook:${who.task}` : who.role);
    t.needs = [...new Set(spec.needs ?? [])];
    const problem = graphProblem(Object.values(this.state.tasks));
    if (problem) {
      this.state.tasks = before.tasks;
      this.state.seq = before.seq;
      throw new Fail(problem);
    }
    if (goal.status === "done") goal.status = "active";
    this.emit({ type: "plan", from: t.by, to: "chef", goal: goal.id, task: t.id, text: `Added ${t.id} “${t.title}”${t.needs.length ? ` after ${t.needs.join(", ")}` : ""}` });
    this.changed();
    return t;
  }

  // ---- asks: the only way anything reaches the chef

  askCreate(p, who) {
    const taskId = who.role === "cook" ? who.task : p.task ?? who.task ?? null;
    const task = taskId ? this.task(taskId) : null;
    const kind = ["question", "decision", "access", "approval", "review", "land", "stuck"].includes(p.kind) ? p.kind : "question";
    const title = clip(p.title, 240);
    if (!title) throw new Fail("An ask needs a question");
    const from = p.from ?? (who.role === "cook" ? `cook:${taskId}` : who.role);
    const dup = this.openAsks(taskId).find((a) => a.title === title && a.kind === kind);
    if (dup) return dup;
    // Questions go to the sous chef first, who answers what the brief and notes already settle.
    const sousFirst = who.role === "cook" && (kind === "question" || kind === "decision") && this.config.calls?.triage && !p.direct;
    const ask = {
      id: this.nextId("ask", "A"),
      task: taskId,
      goal: task?.goal ?? p.goal ?? null,
      from,
      to: p.to ?? (sousFirst ? "sous" : "chef"),
      kind,
      title,
      body: clip(p.body, 3000),
      options: (p.options ?? []).map((o) => clip(o, 160)).slice(0, 6),
      pick: p.pick ? clip(p.pick, 160) : null, // what the asker would choose
      command: p.command ?? null,
      rule: p.rule ?? null,
      tier: p.tier ?? null,
      undo: p.undo ?? null,
      sig: p.sig ?? null,
      on: p.on ?? null, // option -> internal action, for asks the expediter raises
      status: "open",
      createdAt: now(),
    };
    this.state.asks[ask.id] = ask;
    this.emit({ type: "ask", from, to: ask.to, task: taskId, goal: ask.goal, ask: ask.id, text: `${ask.id} ${title}` });
    this.changed();
    return ask;
  }

  #deliver(ask, item) {
    const t = ask.task ? this.state.tasks[ask.task] : null;
    if (t && !["done", "cancelled"].includes(t.status)) t.inbox.push({ ask: ask.id, ...item });
  }

  askAnswer({ id, text }, who) {
    const ask = this.ask(id);
    if (ask.status !== "open") throw new Fail(`${id} is already ${ask.status}`);
    if (who.role === "sous" && ask.to !== "sous") throw new Fail(`${id} is the chef's to answer`, 403);
    if (ask.kind === "approval" || ask.kind === "land") throw new Fail(`${id} is an approval: use approve or deny`);
    const answer = String(text ?? "").trim();
    if (!answer) throw new Fail("An answer needs some text");
    Object.assign(ask, { status: "answered", answer, by: who.role, resolvedAt: now() });
    this.emit({ type: "answer", from: who.role, to: ask.from, task: ask.task, goal: ask.goal, ask: id, text: `${id} → ${answer}` });
    const action = ask.on?.[answer];
    if (action) this.expo?.act(action, ask);
    else this.#deliver(ask, { kind: "answer", by: who.role, question: ask.title, text: answer });
    this.changed();
    return ask;
  }

  // The sous chef hands a question up, reworded so the chef can decide in one read.
  askEscalate({ id, title, body, options, pick }, who) {
    const ask = this.ask(id);
    if (ask.status !== "open") throw new Fail(`${id} is already ${ask.status}`);
    if (title) ask.title = clip(title, 240);
    if (body) ask.body = clip(body, 3000);
    if (options?.length) ask.options = options.map((o) => clip(o, 160)).slice(0, 6);
    if (pick) ask.pick = clip(pick, 160);
    ask.to = "chef";
    ask.escalatedBy = who.role;
    this.emit({ type: "ask", from: who.role, to: "chef", task: ask.task, goal: ask.goal, ask: id, text: `${id} ${ask.title}` });
    this.changed();
    return ask;
  }

  askApprove({ id, note, always }, who) {
    const ask = this.ask(id);
    if (ask.status !== "open") throw new Fail(`${id} is already ${ask.status}`);
    if (ask.kind !== "approval" && ask.kind !== "land") throw new Fail(`${id} is a question: answer it instead`);
    Object.assign(ask, { status: "approved", by: who.role, note: note ? clip(note, 500) : null, resolvedAt: now() });
    this.emit({ type: "approval", from: "chef", to: ask.from, task: ask.task, goal: ask.goal, ask: id, text: `${id} approved${note ? ` — ${note}` : ""}` });
    if (ask.kind === "land") this.expo?.act(ask.task ? ["ticket.land", ask.task] : ["goal.land", ask.goal], ask);
    else {
      this.state.grants.push({ ask: id, task: ask.task, sig: ask.sig, command: ask.command, expiresAt: now() + (this.policy.grantMinutes ?? 120) * 60000, used: false });
      if (always && ask.command) this.policyAllow(ask.command);
      this.#deliver(ask, { kind: "approved", command: ask.command, text: note ?? "" });
    }
    this.changed();
    return ask;
  }

  askDeny({ id, note }, who) {
    const ask = this.ask(id);
    if (ask.status !== "open") throw new Fail(`${id} is already ${ask.status}`);
    Object.assign(ask, { status: "denied", by: who.role, note: note ? clip(note, 500) : null, resolvedAt: now() });
    this.emit({ type: "approval", from: "chef", to: ask.from, task: ask.task, goal: ask.goal, ask: id, text: `${id} denied${note ? ` — ${note}` : ""}` });
    if (ask.kind === "land" && ask.task) this.task(ask.task).status = "paused"; // not now: `oui resume` asks again
    else if (ask.kind === "land") {
      const g = this.state.goals[ask.goal];
      if (g) Object.assign(g, { landAsk: null, landDeferred: true }); // not now: `oui land` does it later
    } else this.#deliver(ask, { kind: "denied", command: ask.command, question: ask.title, text: note ?? "" });
    this.changed();
    return ask;
  }

  withdrawAsks(taskId, why) {
    for (const a of this.openAsks(taskId)) Object.assign(a, { status: "withdrawn", note: why, resolvedAt: now() });
  }

  // ---- what cook say

  note({ text }, who) {
    const t = this.task(who.task);
    t.note = clip(text, 200);
    t.noteAt = now();
    this.emit({ type: "note", from: `cook:${t.id}`, to: "board", task: t.id, goal: t.goal, text: t.note });
    this.changed();
    return { ok: true };
  }

  msg({ to, text }, who) {
    const body = clip(text, 1200);
    if (!body) throw new Fail("A message needs some text");
    const from = who.role === "cook" ? `cook:${who.task}` : who.role;
    let target = String(to ?? "sous");
    const mine = who.task ? this.state.tasks[who.task] : null;
    const byKey = Object.values(this.state.tasks).find((t) => t.key && t.key === target && (!mine || t.goal === mine.goal));
    if (byKey) target = byKey.id;
    if (/^T\d+$/i.test(target)) {
      const t = this.task(target.toUpperCase());
      target = `cook:${t.id}`;
      if (["done", "cancelled", "failed"].includes(t.status)) throw new Fail(`${t.id} is ${t.status}; nobody is there to read it. Tell the sous chef instead: oui msg sous "…"`);
      t.inbox.push({ kind: "msg", from, text: body });
    } else if (!["sous", "chef"].includes(target)) throw new Fail("Send to a ticket id (T4), sous, or chef");
    this.emit({ type: "msg", from, to: target, task: who.task ?? null, goal: who.task ? this.state.tasks[who.task]?.goal : null, text: body });
    this.changed();
    return { ok: true, to: target };
  }

  done(p, who) {
    const t = this.task(who.role === "cook" ? who.task : p.task);
    const summary = clip(p.summary, 900);
    if (!summary) throw new Fail("oui done needs --summary: what changed, in a few sentences");
    t.report = { summary, handoff: clip(p.handoff, 900), evidence: clip(p.evidence, 600), pr: p.pr ?? null, at: now() };
    t.failure = null;
    fs.writeFileSync(path.join(this.taskDir(t.id), "report.md"), `# ${t.id} ${t.title}\n\n${summary}\n\n## For whoever comes next\n${t.report.handoff || "—"}\n\n## Evidence\n${t.report.evidence || "—"}\n`);
    this.emit({ type: "report", from: `cook:${t.id}`, to: "sous", task: t.id, goal: t.goal, text: `done — ${summary}` });
    this.changed();
    return { ok: true, text: "Recorded. End your turn now; Oui Chef will check the work and take it from here." };
  }

  fail(p, who) {
    const t = this.task(who.role === "cook" ? who.task : p.task);
    t.failure = clip(p.why, 900) || "No reason given";
    t.report = null;
    this.emit({ type: "report", from: `cook:${t.id}`, to: "sous", task: t.id, goal: t.goal, text: `cannot finish — ${t.failure}` });
    this.changed();
    return { ok: true, text: "Recorded. End your turn now." };
  }

  inbox(_p, who) {
    const t = this.task(who.task);
    const items = t.inbox.splice(0);
    if (items.length) this.changed();
    return { items };
  }

  verdict({ task, verdict, notes }, who) {
    const t = this.task(task ?? who.task);
    if (!["pass", "changes"].includes(verdict)) throw new Fail("verdict is pass or changes");
    t.review = { verdict, notes: clip(notes, 1500), by: who.role, at: now() };
    this.emit({ type: "review", from: who.role, to: `cook:${t.id}`, task: t.id, goal: t.goal, text: verdict === "pass" ? `passed review${notes ? ` — ${clip(notes, 200)}` : ""}` : `changes wanted — ${clip(notes, 300)}` });
    this.changed();
    return { ok: true };
  }

  // ---- the guard's decisions

  guard({ tool, input, cwd, verdict }, who) {
    const t = who.task ? this.state.tasks[who.task] : null;
    const command = tool === "Bash" ? String(input?.command ?? "") : `${tool} ${input?.file_path ?? input?.notebook_path ?? ""}`.trim();
    // An approval covers the risky commands themselves, so `x` and `x; echo $?` are the same request.
    const held = (verdict?.hits ?? []).filter((h) => h.tier === 2).map((h) => h.command ?? command).sort();
    const sig = crypto.createHash("sha256").update(`${tool}\n${(held.length ? held.join("\n") : command).replace(/[ \t]+/g, " ").trim()}`).digest("hex").slice(0, 24);
    const context = who.role === "cook" && t ? this.#mailFor(t) : null;
    const tier = verdict?.tier ?? 0;
    if (t && tool === "Bash") {
      t.lastTool = { name: "Bash", detail: clip(command, 120), at: now() };
      t.activeAt = now();
    }
    if (tier === 0) return { decision: "allow", context };

    const record = (decision, extra = {}) => {
      const action = { id: this.nextId("action", "X"), ts: now(), task: who.task ?? null, role: who.role, cwd, tool, command, tier, rule: verdict.rule, about: verdict.about, why: verdict.why, hits: verdict.hits, undo: verdict.undo ?? [], decision, ...extra };
      this.ledger.push(action);
      appendLine(P.ledger(), action);
      return action;
    };

    if (tier >= 3) {
      record("refused");
      this.emit({ type: "guard", from: "pass", to: who.role === "cook" ? `cook:${who.task}` : who.role, task: who.task ?? null, goal: t?.goal ?? null, text: `refused: ${verdict.why}` });
      this.changed();
      return { decision: "deny", reason: `REFUSED at the pass: ${verdict.why}. This is not something the chef approves case by case; do not look for another way to do it. If the ticket truly cannot continue without it, say so with oui ask.`, context };
    }
    // Mates and reviewers only read. Anything that changes the world is the cook's job.
    if (who.role !== "cook") {
      record("refused");
      return { decision: "deny", reason: `REFUSED: as ${who.role} you look and decide, you do not change things (${verdict.why}).`, context };
    }

    if (tier === 2) {
      const grant = this.state.grants.find((g) => !g.used && g.task === who.task && g.sig === sig && g.expiresAt > now());
      if (!grant) {
        const open = this.openAsks(who.task).find((a) => a.kind === "approval" && a.sig === sig);
        const denied = Object.values(this.state.asks).find((a) => a.kind === "approval" && a.sig === sig && a.task === who.task && a.status === "denied" && now() - a.resolvedAt < 6 * 3600000);
        if (denied) {
          record("denied");
          return { decision: "deny", reason: `The chef already said no to this (${denied.id}${denied.note ? `: ${denied.note}` : ""}). Do not run it or route around it. Find another way within your ticket, or report with oui done / oui fail.`, context };
        }
        const ask =
          open ??
          this.askCreate(
            { kind: "approval", task: who.task, from: `pass:${who.task}`, to: "chef", title: `${verdict.about}`, body: verdict.why, command, rule: verdict.rule, tier, sig, undo: (verdict.undo ?? []).map((u) => ({ summary: u.summary, steps: (u.steps ?? []).map((x) => x.replace(/\{dir\}\//g, "<checkpoint>/").replace(/\{@[^}]+\}/g, "<saved value>")), note: u.note })) },
            { role: "guard", task: who.task },
          );
        if (!open) record("held", { ask: ask.id });
        this.changed();
        return {
          decision: "deny",
          reason: `HELD at the pass for the chef's approval as ${ask.id}: ${verdict.about} — ${verdict.why}.\nDo not retry it, reword it or work around it. Carry on with anything that does not depend on it. When nothing else is left, end your turn: you will be resumed with the chef's decision, and if it is approved you run the command exactly as you wrote it.`,
          context,
        };
      }
      grant.used = true;
      const action = record("approved", { ask: grant.ask });
      this.emit({ type: "guard", from: "pass", to: "board", task: who.task, goal: t?.goal ?? null, action: action.id, text: `${action.id} ran with the chef's approval (${grant.ask}): ${clip(command, 160)}` });
      this.changed();
      return { decision: "allow", action: action.id, dir: this.checkpointDir(action), capture: verdict.capture ?? [], context };
    }

    const action = record("ran");
    this.emit({ type: "guard", from: "pass", to: "board", task: who.task, goal: t?.goal ?? null, action: action.id, text: `${action.id} ${verdict.about}: ${clip(command, 160)}` });
    this.changed();
    return { decision: "allow", action: action.id, dir: this.checkpointDir(action), capture: verdict.capture ?? [], context };
  }

  // Something Oui Chef itself did on the chef's behalf (landing a goal), kept with its undo.
  recordAction(a) {
    const action = { id: this.nextId("action", "X"), ts: now(), task: a.task ?? null, goal: a.goal ?? null, role: "expediter", cwd: a.cwd, tool: "oui", command: a.command, tier: 1, rule: a.rule, about: a.about, why: a.why, hits: [], undo: a.undo ?? [], decision: "ran" };
    this.ledger.push(action);
    appendLine(P.ledger(), action);
    return action;
  }

  // The cook's Stop hook: a turn may end once there is a report, a failure or an open ask.
  hookStop({ active }, who) {
    const t = who.role === "cook" ? this.state.tasks[who.task] : null;
    if (!t || active) return { block: false };
    const reported = t.report && t.report.at >= (t.turnStartedAt ?? 0);
    if (reported || t.failure || this.openAsks(t.id).length) return { block: false };
    return { block: true, reason: "You are ending your turn without reporting. If the ticket is finished: commit, then run oui done --summary \"...\". If you are stuck or need a decision: oui ask, oui need or oui fail. Otherwise keep working." };
  }

  // One ticket, goal or ask in full, for `oui show`.
  show({ id }) {
    const s = this.state;
    const key = String(id ?? "").toUpperCase();
    if (s.tasks[key]) {
      const t = s.tasks[key];
      let log = "";
      try {
        log = fs.readFileSync(path.join(P.task(key), "log.txt"), "utf8").split("\n").slice(-25).join("\n");
      } catch {}
      return { kind: "ticket", task: t, goal: s.goals[t.goal], asks: Object.values(s.asks).filter((a) => a.task === key), log };
    }
    if (s.goals[key]) return { kind: "goal", goal: s.goals[key], tasks: Object.values(s.tasks).filter((t) => t.goal === key) };
    if (s.asks[key]) return { kind: "ask", ask: s.asks[key] };
    throw new Fail(`Nothing called ${id}`, 404);
  }

  checkpointDir(action) {
    return path.join(action.task ? P.task(action.task) : P.roles(), "checkpoints", action.id);
  }

  #patchAction(id, set) {
    const action = this.ledger.find((a) => a.id === id);
    if (!action) throw new Fail(`No action ${id}`, 404);
    Object.assign(action, set);
    appendLine(P.ledger(), { patch: id, set });
    return action;
  }

  guardCaptured({ action, results }, who) {
    const a = this.ledger.find((x) => x.id === action);
    if (!a || (who.role === "cook" && a.task !== who.task)) throw new Fail(`No action ${action}`, 404);
    this.#patchAction(action, { captured: results });
    return { ok: true };
  }

  // Messages for a cook that is mid-turn ride in on its next tool call.
  #mailFor(t) {
    const mail = t.inbox.filter((m) => m.kind === "msg");
    if (!mail.length) return null;
    t.inbox = t.inbox.filter((m) => m.kind !== "msg");
    return `Messages for you (delivered by Oui Chef):\n${mail.map((m) => `- from ${m.from}: ${m.text}`).join("\n")}`;
  }

  actions({ task, limit = 50 }) {
    return this.ledger
      .filter((a) => !task || a.task === task)
      .slice(-limit)
      .reverse()
      .map((a) => ({ ...a, recipe: a.decision === "ran" || a.decision === "approved" ? renderUndo(a.undo, this.checkpointDir(a)) : [] }));
  }

  undo({ id, run }) {
    const action = this.ledger.find((a) => a.id === id);
    if (!action) throw new Fail(`No action ${id}`, 404);
    if (!["ran", "approved"].includes(action.decision)) throw new Fail(`${id} never ran (${action.decision}), so there is nothing to undo`);
    const recipe = renderUndo(action.undo, this.checkpointDir(action));
    const runnable = recipe.some((r) => r.steps.length);
    if (!run) return { action, recipe, runnable, undone: Boolean(action.undone) };
    if (action.undone) throw new Fail(`${id} was already undone`);
    if (!runnable) throw new Fail(`${id} has no automatic undo. ${recipe.map((r) => r.note).filter(Boolean).join(" ") || "Nothing was recorded for it."}`);
    const result = runUndo(recipe.filter((r) => r.steps.length), fs.existsSync(action.cwd) ? action.cwd : home());
    if (result.ok) this.#patchAction(id, { undone: now() });
    this.emit({ type: "guard", from: "chef", to: "board", task: action.task, action: id, text: result.ok ? `undid ${id}: ${clip(action.command, 140)}` : `undo of ${id} failed at: ${clip(result.results.at(-1)?.step, 140)}` });
    this.changed();
    return { action, recipe, ...result };
  }

  // ---- policy and preferences

  policyAllow(command) {
    const file = readJson(P.policy(), {}) ?? {};
    const exact = `/^${command.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/`;
    file.allow = [...new Set([...(file.allow ?? []), exact])];
    writeJsonAtomic(P.policy(), file);
    this.policy = loadPolicy();
  }

  policySet({ rule, tier }) {
    if (!RULES[rule]) throw new Fail(`No rule ${rule}. See: oui policy rules`);
    const file = readJson(P.policy(), {}) ?? {};
    file.tiers = { ...(file.tiers ?? {}) };
    if (tier === "default") delete file.tiers[rule];
    else {
      const n = { run: 0, record: 1, allow: 1, hold: 2, ask: 2, never: 3, deny: 3 }[tier] ?? Number(tier);
      if (![0, 1, 2, 3].includes(n)) throw new Fail("tier is run, record, hold, never or default");
      file.tiers[rule] = n;
    }
    writeJsonAtomic(P.policy(), file);
    this.policy = loadPolicy();
    this.emit({ type: "system", from: "chef", to: "board", text: `policy: ${rule} → ${TIER_NAME[tierOf(rule, this.policy)]}` });
    this.changed();
    return { rule, tier: tierOf(rule, this.policy), name: TIER_NAME[tierOf(rule, this.policy)] };
  }

  policyRules() {
    return Object.entries(RULES).map(([rule, [tier, about]]) => ({ rule, about, default: tier, tier: tierOf(rule, this.policy) }));
  }

  // Standing preferences: one line each, handed to every cook and to the sous chef.
  remember({ text }) {
    const line = clip(text, 400);
    if (!line) throw new Fail("Nothing to remember");
    ensureDir(path.dirname(P.notes()));
    fs.appendFileSync(P.notes(), `- ${line}\n`);
    this.emit({ type: "system", from: "chef", to: "sous", text: `remember: ${line}` });
    this.changed();
    return { ok: true };
  }

  preferences() {
    try {
      return fs.readFileSync(P.notes(), "utf8").trim();
    } catch {
      return "";
    }
  }

  service({ on }) {
    this.state.service.on = Boolean(on);
    this.emit({ type: "system", from: "chef", to: "board", text: `service ${on ? "on" : "paused"}` });
    this.changed();
    return this.state.service;
  }

  // Resolves when the board changes, or after `ms`.
  waitForChange(rev, ms) {
    if (this.state.rev !== rev) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(false);
      }, ms);
      this.waiters.add(wake);
    });
  }
}
