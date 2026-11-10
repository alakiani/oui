// The expediter: everything mechanical, done without a model. It starts tickets
// when what they need is finished, runs each cook a turn at a time, delivers
// answers, checks finished work, merges it and lands goals. The only things it
// hands to a model are judgement calls (plan, triage, review), each as a short
// stateless run that starts from a few paragraphs and ends with one command.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { P, OUI_BIN, ensureDir, home } from "./paths.mjs";
import { startOrder } from "./graph.mjs";
import { cookBrief, cookContract, resumeMessage, rolePrompt } from "./brief.mjs";
import * as gitx from "./git.mjs";
import { Fail, clip, slug } from "./kitchen.mjs";
import { quote } from "./guard/shell.mjs";
import * as claude from "./harness/claude.mjs";
import * as stub from "./harness/stub.mjs";

const HARNESS = { claude, stub };
const now = () => Date.now();
const stamp = () => new Date().toTimeString().slice(0, 8);

function shell(cmd, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d) => {
      out = (out + d).slice(-6000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim() });
    });
  });
}

export class Expediter {
  constructor(kitchen) {
    this.kitchen = kitchen;
    this.harness = HARNESS[kitchen.config.harness] ?? claude;
    this.running = new Map(); // ticket id -> { child, startedAt }
    this.roles = new Map(); // "kind:subject" -> promise
    this.reviewing = new Set();
    this.landing = new Set();
    kitchen.expo = this;
    kitchen.onChange = () => this.kick();
    this.shim = this.#writeShim();
    this.timer = setInterval(() => this.kick(), 4000);
    this.timer.unref?.();
  }

  // ---- small things

  #writeShim() {
    const dir = ensureDir(path.join(home(), "bin"));
    const file = path.join(dir, "oui");
    fs.writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(OUI_BIN)} "$@"\n`, { mode: 0o755 });
    return dir;
  }

  log(taskId, text) {
    fs.appendFileSync(path.join(this.kitchen.taskDir(taskId), "log.txt"), `${stamp()} ${text}\n`);
  }

  // Tool activity changes the board often; save at most once a second.
  touch() {
    if (this.touching) return;
    this.touching = setTimeout(() => {
      this.touching = null;
      this.kitchen.changed();
    }, 1000);
    this.touching.unref?.();
  }

  kick() {
    if (this.kicked || this.stopped) return;
    this.kicked = true;
    setImmediate(() => {
      this.kicked = false;
      this.tick().catch((e) => console.error("expediter:", e));
    });
  }

  agentEnv(role, subject, extra = {}) {
    return { ...process.env, OUI_HOME: home(), OUI_ROLE: role, OUI_TOKEN: this.kitchen.token(role, subject), OUI_PORT: String(this.kitchen.port ?? ""), PATH: `${this.shim}${path.delimiter}${process.env.PATH ?? ""}`, ...extra };
  }

  // The hooks that put every tool call in front of the guard.
  writeSettings(dir, role) {
    const run = (what) => `${quote(process.execPath)} ${quote(OUI_BIN)} hook ${what}`;
    const hooks = { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: run("pretool"), timeout: 120 }] }] };
    if (role === "cook") hooks.Stop = [{ hooks: [{ type: "command", command: run("stop"), timeout: 30 }] }];
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ hooks }, null, 1));
    return file;
  }

  raise(target, title, body, on) {
    return this.kitchen.askCreate({ kind: "stuck", task: target.task ?? null, goal: target.goal ?? null, from: "expediter", to: "chef", title, body, options: Object.keys(on).filter((k) => k !== "*"), on }, { role: "expediter" });
  }

  // ---- the loop

  async tick() {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        this.#tick();
      } while (this.again);
    } finally {
      this.ticking = false;
    }
  }

  #tick() {
    const { kitchen } = this;
    const s = kitchen.state;
    const on = s.service.on;
    let dirty = false;

    // Goals waiting for a plan.
    for (const goal of Object.values(s.goals)) {
      if (goal.status !== "planning" || goal.planTried || !on) continue;
      goal.planTried = true;
      dirty = true;
      this.#planGoal(goal);
    }

    // Questions the sous chef may be able to settle without the chef.
    for (const ask of kitchen.openAsks()) {
      if (ask.to !== "sous" || ask.triaged) continue;
      ask.triaged = true;
      dirty = true;
      this.runRole("triage", { ask }).then(() => {
        if (ask.status === "open" && ask.to === "sous") kitchen.askEscalate({ id: ask.id }, { role: "sous" });
      });
    }

    for (const task of Object.values(s.tasks)) {
      // Parked cooks whose questions are all settled go back to work.
      if (task.status === "blocked" && task.kind !== "land" && on && !this.running.has(task.id) && !kitchen.openAsks(task.id).length && s.goals[task.goal]?.status === "active") {
        if (task.resumeAfter && task.resumeAfter > now()) continue;
        if (this.running.size >= kitchen.config.maxCooks) continue;
        this.#startTurn(task, resumeMessage(task), true);
        dirty = true;
      }
      if (task.status === "review" && !this.reviewing.has(task.id)) {
        this.reviewing.add(task.id);
        this.#review(task)
          .catch((e) => this.#hardFail(task, `Checking the work failed: ${e.message}`))
          .finally(() => {
            this.reviewing.delete(task.id);
            this.kick();
          });
      }
    }

    // Goals whose tickets are all finished.
    for (const goal of Object.values(s.goals)) {
      if (goal.status !== "active") continue;
      const mine = Object.values(s.tasks).filter((t) => t.goal === goal.id && t.status !== "cancelled");
      const complete = mine.length > 0 && mine.every((t) => t.status === "done");
      if (!complete) {
        if (goal.completedAt) {
          goal.completedAt = null;
          goal.landDeferred = false;
          dirty = true;
        }
        continue;
      }
      if (goal.completedAt) continue;
      goal.completedAt = now();
      dirty = true;
      this.#goalComplete(goal, mine);
    }

    // Start what is ready, in order.
    if (on) {
      const tasks = Object.values(s.tasks);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const task of startOrder(tasks, byId, s.goals)) {
        if (this.running.size >= kitchen.config.maxCooks) break;
        const project = s.projects[task.project];
        const inProject = [...this.running.keys()].map((id) => s.tasks[id]).filter((t) => t.project === project.id);
        if (inProject.length >= (project.maxCooks ?? 3)) continue;
        // Without git there are no worktrees, so code changes in one folder go one at a time.
        if (!project.git && task.kind !== "scout" && inProject.some((t) => t.kind !== "scout")) continue;
        this.#dispatch(task);
        dirty = true;
      }
    }
    if (dirty) kitchen.changed();
  }

  // ---- cooks

  #dispatch(task) {
    const { kitchen } = this;
    const s = kitchen.state;
    const project = s.projects[task.project];
    const goal = s.goals[task.goal];
    const dir = kitchen.taskDir(task.id);
    if (task.kind === "land") return this.#landStep(task);
    let workdir = project.path;
    // Build and ops tickets get their own worktree cut from the goal branch, so they see
    // everything finished so far. Scouts only read, so they use the project folder.
    if (project.git && task.kind !== "scout") {
      goal.branch ??= `oui/${goal.id}-${slug(goal.title, 28)}`;
      const made = gitx.ensureBranch(project.path, goal.branch, project.base);
      if (!made.ok) return this.#hardFail(task, `Could not create branch ${goal.branch} from ${project.base}: ${made.err}`);
      task.branch ??= `oui/${goal.id}/${task.id}-${slug(task.title, 28)}`;
      workdir = path.join(P.worktrees(), project.id, task.id);
      const wt = gitx.ensureWorktree(project.path, workdir, task.branch, goal.branch);
      if (!wt.ok) return this.#hardFail(task, `Could not create a worktree for ${task.id}: ${wt.err}`);
      // A retried ticket picks up whatever landed on the goal branch since it was cut.
      if (wt.reused) gitx.git(workdir, ["merge", "--no-edit", goal.branch]);
    }
    task.workdir = workdir;
    task.session = crypto.randomUUID();
    task.startedAt ??= now();
    const brief = cookBrief(kitchen, task);
    fs.writeFileSync(path.join(dir, "brief.md"), brief);
    kitchen.emit({ type: "system", from: "expediter", to: `cook:${task.id}`, task: task.id, goal: task.goal, text: `fired ${task.id} “${task.title}”` });
    this.#startTurn(task, brief, false);
  }

  #startTurn(task, prompt, resume) {
    const { kitchen } = this;
    const s = kitchen.state;
    const project = s.projects[task.project];
    const dir = kitchen.taskDir(task.id);
    if (!task.session || !task.workdir || !fs.existsSync(task.workdir)) return this.#dispatch(task);
    const env = this.agentEnv("cook", task.id, {
      OUI_TASK: task.id,
      OUI_GOAL: task.goal,
      OUI_ROOTS: JSON.stringify([task.workdir, dir]),
      OUI_PROTECTED: JSON.stringify([project.base, ...(project.protected ?? [])].filter(Boolean)),
    });
    const run = this.harness.command({
      kind: "cook",
      prompt,
      session: task.session,
      resume,
      settings: this.writeSettings(dir, "cook"),
      system: cookContract(),
      addDirs: [dir],
      model: kitchen.config.model,
      budget: kitchen.config.budgetUsdPerTurn,
      label: `${task.id} ${task.title}`,
      stubKey: task.key ?? task.id,
    });
    task.status = "running";
    task.turns++;
    task.turnStartedAt = now();
    task.activeAt = now();
    task.resumeAfter = null;
    const turn = { startedAt: now(), lastText: "", result: null, stderr: "" };
    this.log(task.id, `── turn ${task.turns} ${resume ? "resumed" : "started"} ──`);
    if (resume) this.log(task.id, `  ⇠ ${clip(prompt.replace(/\s+/g, " "), 300)}`);
    const raw = fs.createWriteStream(path.join(dir, `turn-${task.turns}.jsonl`));
    let child;
    try {
      child = spawn(run.cmd, run.args, { cwd: task.workdir, env: { ...env, ...run.env }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return this.#hardFail(task, `Could not start ${run.cmd}: ${e.message}`);
    }
    turn.child = child;
    this.running.set(task.id, turn);
    child.stdin.on("error", () => {});
    child.stdin.end(run.stdin);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        raw.write(line + "\n");
        for (const ev of this.harness.parse(line)) this.#onEvent(task, turn, ev);
      }
    });
    child.stderr.on("data", (d) => {
      turn.stderr = (turn.stderr + d).slice(-800);
    });
    const timer = setTimeout(() => {
      turn.timedOut = true;
      child.kill("SIGTERM");
    }, kitchen.config.turnTimeoutMinutes * 60000);
    const end = (code, spawnError) => {
      if (turn.ended) return;
      turn.ended = true;
      clearTimeout(timer);
      raw.end();
      this.running.delete(task.id);
      this.#onTurnEnd(task, turn, code, spawnError);
    };
    child.on("error", (e) => end(null, e));
    child.on("close", (code) => end(code, null));
  }

  #onEvent(task, turn, ev) {
    if (ev.type === "text") {
      turn.lastText = ev.text;
      this.log(task.id, `  ${clip(ev.text.replace(/\s+/g, " "), 400)}`);
    } else if (ev.type === "tool") {
      task.lastTool = { name: ev.name, detail: clip(ev.detail.replace(/\s+/g, " "), 120), at: now() };
      task.activeAt = now();
      this.log(task.id, `▸ ${ev.name} ${clip(ev.detail.replace(/\s+/g, " "), 220)}`);
      this.touch();
    } else if (ev.type === "refused") this.log(task.id, `  ✕ ${clip(ev.text.replace(/\s+/g, " "), 240)}`);
    else if (ev.type === "result") turn.result = ev;
  }

  #onTurnEnd(task, turn, code, spawnError) {
    const { kitchen } = this;
    const cfg = kitchen.config;
    task.cost = (task.cost ?? 0) + (turn.result?.cost ?? 0);
    const error = spawnError
      ? spawnError.code === "ENOENT"
        ? `the ${kitchen.config.harness} command was not found on this machine`
        : spawnError.message
      : turn.timedOut
        ? `the turn ran past ${cfg.turnTimeoutMinutes} minutes and was stopped`
        : turn.result && !turn.result.ok
          ? clip(turn.result.error, 300)
          : !turn.result && code !== 0
            ? clip(turn.stderr || `exit ${code}`, 300)
            : null;
    this.log(task.id, `── turn ${task.turns} ended${error ? ` with an error: ${error}` : ""} ──`);
    if (task.status !== "running") return kitchen.changed(); // paused or cancelled while it ran

    const reported = task.report && task.report.at >= task.turnStartedAt;
    if (reported) {
      task.status = "review";
      task.reviewStage = null;
      task.nudges = 0;
      task.errors = 0;
    } else if (task.failure) this.#hardFail(task, task.failure, true);
    else if (kitchen.openAsks(task.id).length) task.status = "blocked";
    // A decision that arrived while the turn was winding down: it stopped to wait for exactly this.
    else if (!error && task.inbox.some((m) => ["answer", "approved", "denied", "msg"].includes(m.kind))) task.status = "blocked";
    else if (error) {
      task.errors = (task.errors ?? 0) + 1;
      if (spawnError?.code === "ENOENT" || task.errors > 2) this.#hardFail(task, `The cook's process failed: ${error}`);
      else {
        task.status = "blocked";
        task.resumeAfter = now() + 4000 * task.errors;
        task.inbox.push({ kind: "system", text: `Your last turn stopped with an error (${error}). Check where you left off and carry on.` });
        setTimeout(() => this.kick(), 4000 * task.errors + 50).unref?.();
      }
    } else {
      // Ended without a report, an ask or a failure: nudge, then hand its last words to the chef.
      task.nudges = (task.nudges ?? 0) + 1;
      task.status = "blocked";
      if (task.nudges <= cfg.maxNudges) task.inbox.push({ kind: "system", text: "You ended your turn without reporting. If the ticket is finished, commit and run oui done. If you are stuck, say why with oui ask or oui fail. Otherwise keep working." });
      else
        this.raise({ task: task.id }, `${task.id} stopped without finishing or asking`, `Its last words: ${clip(turn.lastText || "(nothing)", 800)}`, {
          "Tell it to continue": ["ticket.retry", task.id],
          "Cancel ticket": ["ticket.cancel", task.id],
          "*": ["ticket.retry", task.id],
        });
    }
    kitchen.changed();
  }

  // A ticket that cannot go on by itself. The chef chooses what happens to it.
  #hardFail(task, why, said = false) {
    task.status = "failed";
    task.failure = clip(why, 900);
    task.finishedAt = now();
    this.raise({ task: task.id }, `${task.id} ${said ? "could not finish" : "failed"}: ${clip(why, 180)}`, why, {
      Retry: ["ticket.retry", task.id],
      "Accept as done": ["ticket.accept", task.id],
      "Cancel ticket": ["ticket.cancel", task.id],
      "*": ["ticket.retry", task.id],
    });
    this.kitchen.changed();
  }

  // ---- checking finished work

  #sendBack(task, text) {
    const { kitchen } = this;
    task.attempt = (task.attempt ?? 0) + 1;
    task.report = null;
    task.reviewStage = null;
    task.accepted = false;
    task.status = "blocked";
    kitchen.emit({ type: "review", from: "expediter", to: `cook:${task.id}`, task: task.id, goal: task.goal, text: `sent back: ${clip(text.split("\n")[0], 200)}` });
    if (task.attempt >= kitchen.config.maxAttempts)
      this.raise({ task: task.id }, `${task.id} has been sent back ${task.attempt} times`, text, {
        "Try again": ["ticket.retry", task.id],
        "Accept as done": ["ticket.accept", task.id],
        "Cancel ticket": ["ticket.cancel", task.id],
        "*": ["ticket.retry", task.id],
      });
    else task.inbox.push({ kind: "system", text });
    kitchen.changed();
  }

  async #review(task) {
    const { kitchen } = this;
    const s = kitchen.state;
    const project = s.projects[task.project];
    const goal = s.goals[task.goal];
    const isBuild = task.kind !== "scout" && project.git && task.branch;
    const reviewed = isBuild && task.kind === "build";
    const stage = (name) => {
      task.reviewStage = name;
      kitchen.changed();
    };
    if (!task.accepted) {
      if (isBuild) {
        const dirty = gitx.uncommitted(task.workdir);
        if (dirty.length) return this.#sendBack(task, `You reported done with uncommitted changes in your worktree:\n${dirty.slice(0, 8).join("\n")}\nCommit what belongs to the ticket, remove what does not, then run oui done again.`);
      }
      const checks = [...(project.verify ?? []), ...(task.verify ?? [])];
      if (checks.length) stage("verify");
      for (const cmd of checks) {
        const res = await shell(cmd, task.workdir, this.agentEnv("cook", task.id), 30 * 60000);
        this.log(task.id, `${res.ok ? "✓" : "✕"} check: ${cmd}`);
        if (task.status !== "review") return;
        if (!res.ok) return this.#sendBack(task, `A required check failed: \`${cmd}\`\n\n${clip(res.out.slice(-1800), 1800)}\n\nFix it, then run oui done again.`);
      }
      if (reviewed && kitchen.config.calls?.review) {
        stage("review");
        task.review = null;
        await this.runRole("review", { task });
        if (task.status !== "review") return;
        if (task.review?.verdict === "changes") return this.#sendBack(task, `The inspector reviewed your work and wants changes before it merges:\n\n${task.review.notes}\n\nMake them, commit, then run oui done again.`);
        task.unreviewed = !task.review; // the reviewer gave no verdict; say so on the board
      }
    }
    let merged = false;
    if (isBuild) {
      stage("integrate");
      const res = gitx.integrate(project, goal, task);
      merged = res.ok && !res.empty;
      if (!res.ok && res.conflict) return this.#sendBack(task, `Your branch conflicts with \`${goal.branch}\` in ${res.files.join(", ")}: another ticket changed the same code and merged first. In your worktree run \`git merge ${goal.branch}\`, resolve the conflicts so both tickets' work survives, run the checks, commit, then run oui done again.`);
      if (!res.ok) return this.#hardFail(task, `Could not merge ${task.id} into ${goal.branch}: ${res.error}`);
      gitx.removeWorktree(project.path, task.workdir);
    }
    task.status = "done";
    task.reviewStage = null;
    task.finishedAt = now();
    kitchen.withdrawAsks(task.id, "ticket finished");
    kitchen.emit({ type: "review", from: "expediter", to: "board", task: task.id, goal: task.goal, text: `${task.id} done${merged ? ` and merged into ${goal.branch}` : ""}${task.unreviewed ? " (not reviewed)" : ""}` });
    this.log(task.id, "✓ done");
    kitchen.changed();
  }

  // ---- goals

  #planGoal(goal) {
    const { kitchen } = this;
    const fallback = (why) => {
      if (goal.status !== "planning") return;
      kitchen.plan({ goalId: goal.id, tasks: [{ title: goal.title, brief: goal.detail, kind: "build" }] }, { role: "sous" });
      kitchen.emit({ type: "system", from: "expediter", to: "chef", goal: goal.id, text: `${goal.id} runs as a single ticket (${why})` });
      kitchen.changed();
    };
    if (!kitchen.config.calls?.plan) return fallback("planning is off");
    this.runRole("plan", { goal }).then(
      () => fallback("the sous chef did not produce a plan"),
      () => fallback("the planner failed"),
    );
  }

  #goalComplete(goal, tasks) {
    const { kitchen } = this;
    const project = kitchen.state.projects[goal.project];
    const ahead = goal.branch ? gitx.git(project.path, ["rev-list", "--count", `${project.base}..${goal.branch}`]).out : "0";
    if (!project.git || !goal.branch || ahead === "0") {
      goal.status = "done";
      kitchen.emit({ type: "system", from: "expediter", to: "chef", goal: goal.id, text: `${goal.id} “${goal.title}” is complete` });
      return;
    }
    if (project.merge === "auto") return void this.land(goal);
    if (goal.landDeferred) return;
    const how = project.landing === "pr" ? `Push \`${goal.branch}\` and open one pull request against \`${project.base}\`` : `Fast-forward \`${project.base}\` in ${project.path} to \`${goal.branch}\``;
    const ask = kitchen.askCreate(
      {
        kind: "land",
        goal: goal.id,
        from: "expediter",
        to: "chef",
        title: `Land ${goal.id} “${goal.title}”?`,
        body: `All ${tasks.length} ticket${tasks.length === 1 ? "" : "s"} are finished and merged into \`${goal.branch}\` (${gitx.diffStat(project.path, project.base, goal.branch) || "no diff"}).\n${how}.\n\n${tasks.map((t) => `${t.id} ${t.title}: ${clip(t.report?.summary, 200)}`).join("\n")}`,
        undo: [{ summary: project.landing === "pr" ? "Close the pull request and delete the pushed branch" : `Put ${project.base} back on the commit it is on now`, steps: [] }],
      },
      { role: "expediter" },
    );
    goal.landAsk = ask.id;
  }

  // A "land" ticket in the middle of a plan: no cook. It puts everything finished so far on
  // the base branch (or opens the pull request), so tickets after it can rely on that.
  #landStep(task) {
    const { kitchen } = this;
    const goal = kitchen.state.goals[task.goal];
    const project = kitchen.state.projects[task.project];
    task.startedAt ??= now();
    const ahead = project.git && goal.branch ? gitx.git(project.path, ["rev-list", "--count", `${project.base}..${goal.branch}`]).out : "0";
    if (ahead === "0" || !ahead) {
      Object.assign(task, { status: "done", finishedAt: now(), report: { summary: `Nothing new to land on ${project.base ?? "the base branch"}.`, handoff: "", evidence: "", at: now() } });
      return;
    }
    if (project.merge === "auto") return this.#landNow(task);
    task.status = "blocked";
    const how = project.landing === "pr" ? `Push \`${goal.branch}\` and open a pull request against \`${project.base}\`` : `Fast-forward \`${project.base}\` in ${project.path} to \`${goal.branch}\``;
    kitchen.askCreate({ kind: "land", task: task.id, goal: goal.id, from: "expediter", to: "chef", title: `${task.title}: land ${goal.id} so far?`, body: `${how} (${gitx.diffStat(project.path, project.base, goal.branch) || "no diff"}). The tickets after this one wait for it.`, undo: [{ summary: project.landing === "pr" ? "Close the pull request and delete the pushed branch" : `Put ${project.base} back on the commit it is on now`, steps: [] }] }, { role: "expediter" });
  }

  #landNow(task) {
    const { kitchen } = this;
    const goal = kitchen.state.goals[task.goal];
    const project = kitchen.state.projects[task.project];
    const res = project.landing === "pr" ? gitx.landPr(project, goal, `${goal.detail}\n`, goal.pr) : gitx.landLocal(project, goal);
    if (!res.ok) return this.#hardFail(task, `Could not land ${goal.id}: ${res.error}`);
    const action = kitchen.recordAction({ task: task.id, goal: goal.id, cwd: project.path, command: project.landing === "pr" ? `open pull request for ${goal.branch} → ${project.base}` : `land ${goal.branch} → ${project.base} in ${project.path}`, rule: "oui.land", about: "Land finished work", why: `${task.id} ${task.title}`, undo: res.undo ? [{ summary: project.landing === "pr" ? "Close the pull request and delete the pushed branch" : `Put ${project.base} back where it was`, steps: [res.undo] }] : [] });
    if (res.url) goal.pr = res.url;
    const summary = project.landing === "pr" ? `Pushed ${goal.branch} and opened ${res.url}. It is not merged yet.` : `Landed ${goal.branch} on ${project.base} (${String(res.after).slice(0, 8)}).`;
    Object.assign(task, { status: "done", finishedAt: now(), report: { summary, handoff: project.landing === "pr" ? `The pull request is ${res.url}. Merging it is a separate, held step.` : `${project.base} now contains everything finished so far in this goal.`, evidence: "", at: now() } });
    kitchen.emit({ type: "system", from: "expediter", to: "chef", task: task.id, goal: goal.id, action: action.id, text: `${task.id} ${summary} (${action.id} undoes it)` });
    kitchen.changed();
  }

  async land(goal) {
    const { kitchen } = this;
    if (this.landing.has(goal.id)) return;
    this.landing.add(goal.id);
    try {
      const project = kitchen.state.projects[goal.project];
      const tasks = Object.values(kitchen.state.tasks).filter((t) => t.goal === goal.id && t.status === "done");
      const body = `${goal.detail}\n\n## What was done\n${tasks.map((t) => `- **${t.title}**: ${t.report?.summary ?? ""}`).join("\n")}\n`;
      const res = project.landing === "pr" ? gitx.landPr(project, goal, body, goal.pr) : gitx.landLocal(project, goal);
      if (!res.ok) {
        const ask = this.raise({ goal: goal.id }, `Could not land ${goal.id}: ${clip(res.error, 180)}`, res.error, { "Try again": ["goal.land", goal.id], "Leave it for now": ["goal.leave", goal.id] });
        goal.landAsk = ask.id;
        return kitchen.changed();
      }
      const command = project.landing === "pr" ? `open pull request for ${goal.branch} → ${project.base}` : `land ${goal.branch} → ${project.base} in ${project.path}`;
      const action = kitchen.recordAction({ goal: goal.id, cwd: project.path, command, rule: "oui.land", about: "Land a finished goal", why: `${goal.id} ${goal.title}`, undo: [{ summary: project.landing === "pr" ? "Close the pull request and delete the pushed branch" : `Put ${project.base} back where it was`, steps: [res.undo], note: project.landing === "pr" ? undefined : "Only safe while nothing else has landed on top." }] });
      Object.assign(goal, { status: "done", landedAt: now(), pr: res.url ?? null, landAsk: null, landAction: action.id });
      if (project.landing === "local") gitx.removeWorktree(project.path, gitx.goalWorktree(project, goal));
      kitchen.emit({ type: "system", from: "expediter", to: "chef", goal: goal.id, action: action.id, text: project.landing === "pr" ? `${goal.id} is up for review: ${res.url}` : `${goal.id} landed on ${project.base} (${action.id} undoes it)` });
      kitchen.changed();
    } finally {
      this.landing.delete(goal.id);
    }
  }

  // ---- judgement calls: short, stateless, one command out

  runRole(kind, ctx) {
    const subject = ctx.task?.id ?? ctx.ask?.id ?? ctx.goal?.id;
    const id = `${kind}:${subject}`;
    if (this.roles.has(id)) return this.roles.get(id);
    const promise = this.#role(kind, ctx, subject).finally(() => {
      this.roles.delete(id);
      this.kick();
    });
    this.roles.set(id, promise);
    return promise;
  }

  #role(kind, ctx, subject) {
    const { kitchen } = this;
    const s = kitchen.state;
    const role = kind === "review" ? "inspector" : "sous";
    const task = ctx.task ?? (ctx.ask?.task ? s.tasks[ctx.ask.task] : null);
    const project = s.projects[(task ?? ctx.goal)?.project];
    const cwd = task?.workdir && fs.existsSync(task.workdir) ? task.workdir : project?.path ?? home();
    const dir = ensureDir(path.join(P.roles(), `${kind}-${subject}`));
    const env = this.agentEnv(role, task?.id ?? subject, { OUI_TASK: task?.id ?? "", OUI_ASK: ctx.ask?.id ?? "", OUI_GOAL: ctx.goal?.id ?? task?.goal ?? "", OUI_ROOTS: JSON.stringify([dir]), OUI_PROTECTED: "[]" });
    const run = this.harness.command({ kind, prompt: rolePrompt(kind, kitchen, ctx), session: crypto.randomUUID(), resume: false, settings: this.writeSettings(dir, role), model: kitchen.config.sousModel, addDirs: [dir], label: `oui ${kind} ${subject}`, stubKey: task?.key ?? task?.id ?? subject });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(run.cmd, run.args, { cwd, env: { ...env, ...run.env }, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        return resolve(false);
      }
      const raw = fs.createWriteStream(path.join(dir, "run.jsonl"));
      child.stdout.pipe(raw);
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(run.stdin);
      const timer = setTimeout(() => child.kill("SIGTERM"), kitchen.config.roleTimeoutMinutes * 60000);
      const done = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    });
  }

  // ---- what the chef can do to a ticket or a goal

  kill(taskId) {
    this.running.get(taskId)?.child?.kill("SIGTERM");
  }

  act([verb, id], ask) {
    const guidance = ask && !Object.keys(ask.on ?? {}).includes(ask.answer) ? ask.answer : null;
    if (verb === "ticket.retry") return this.retry({ id, note: guidance });
    if (verb === "ticket.accept") return this.accept({ id });
    if (verb === "ticket.cancel") return this.cancel({ id });
    if (verb === "goal.land") return void this.land(this.kitchen.goal(id));
    if (verb === "ticket.land") return this.#landNow(this.kitchen.task(id));
    if (verb === "goal.leave") {
      const g = this.kitchen.goal(id);
      g.landDeferred = true;
      g.landAsk = null;
    }
  }

  pause({ id }) {
    const t = this.kitchen.task(id);
    if (!["running", "blocked", "todo"].includes(t.status)) throw new Fail(`${id} is ${t.status}; nothing to pause`);
    t.pausedFrom = t.status === "todo" ? "todo" : "blocked";
    t.status = "paused";
    this.kill(id);
    this.kitchen.changed();
    return t;
  }

  resume({ id, note }) {
    const t = this.kitchen.task(id);
    if (t.status !== "paused") throw new Fail(`${id} is ${t.status}, not paused`);
    const reported = t.report && t.report.at >= (t.turnStartedAt ?? 0);
    t.status = reported ? "review" : t.pausedFrom === "todo" || !t.session ? "todo" : "blocked";
    if (t.kind === "land") t.status = "todo"; // asked again when its turn comes
    if (t.status === "blocked") t.inbox.push({ kind: "system", text: `The chef paused you and has now let you continue.${note ? ` Their note: ${note}` : ""} Check where you left off.` });
    this.kitchen.changed();
    return t;
  }

  retry({ id, note }) {
    const t = this.kitchen.task(id);
    if (t.status === "running" || t.status === "review") throw new Fail(`${id} is ${t.status}`);
    this.kitchen.withdrawAsks(id, "retried");
    Object.assign(t, { attempt: 0, nudges: 0, errors: 0, failure: null, report: null, finishedAt: null, accepted: false, resumeAfter: null });
    const started = t.session && t.workdir && fs.existsSync(t.workdir);
    t.status = started ? "blocked" : "todo";
    if (started) t.inbox.push({ kind: "system", text: `The chef asked you to try again.${note ? ` Their guidance: ${note}` : ""}` });
    else if (note) t.inbox.push({ kind: "system", text: `Guidance from the chef: ${note}` });
    this.kitchen.emit({ type: "system", from: "chef", to: `cook:${id}`, task: id, goal: t.goal, text: `refire ${id}${note ? ` — ${note}` : ""}` });
    this.kitchen.changed();
    return t;
  }

  cancel({ id }) {
    const t = this.kitchen.task(id);
    this.kill(id);
    this.kitchen.withdrawAsks(id, "ticket cancelled");
    t.status = "cancelled";
    t.finishedAt = now();
    this.kitchen.emit({ type: "system", from: "chef", to: "board", task: id, goal: t.goal, text: `cancelled ${id}` });
    this.kitchen.changed();
    return t;
  }

  // Take the cook's word for it: skip the checks and the review, still merge.
  accept({ id }) {
    const t = this.kitchen.task(id);
    if (t.status === "done") return t;
    this.kill(id);
    this.kitchen.withdrawAsks(id, "accepted by the chef");
    t.report ??= { summary: "Accepted by the chef as it stands.", handoff: "", evidence: "", at: now() };
    t.accepted = true;
    t.failure = null;
    t.status = "review";
    t.reviewStage = null;
    this.kitchen.changed();
    return t;
  }

  // Step into a cook's conversation. The expediter leaves the ticket alone until `oui resume`.
  takeover({ id }) {
    const t = this.kitchen.task(id);
    if (!t.session) throw new Fail(`${id} has not started, so there is no conversation to open`);
    if (["running", "blocked"].includes(t.status)) this.pause({ id });
    const settings = this.writeSettings(this.kitchen.taskDir(id), "cook");
    const project = this.kitchen.state.projects[t.project];
    const env = { OUI_HOME: home(), OUI_ROLE: "cook", OUI_TASK: id, OUI_GOAL: t.goal, OUI_TOKEN: this.kitchen.token("cook", id), OUI_PORT: String(this.kitchen.port ?? ""), OUI_ROOTS: JSON.stringify([t.workdir, this.kitchen.taskDir(id)]), OUI_PROTECTED: JSON.stringify([project.base, ...(project.protected ?? [])].filter(Boolean)), PATH: `${this.shim}${path.delimiter}${process.env.PATH ?? ""}` };
    // The guard stays on while the chef is in the conversation: holds still land on the board.
    return { cwd: t.workdir, argv: [...this.harness.takeover(t.session), "--settings", settings], env, then: `oui resume ${id}` };
  }

  goalSet({ id, status }) {
    const g = this.kitchen.goal(id);
    if (!["active", "paused", "cancelled"].includes(status)) throw new Fail("status is active, paused or cancelled");
    g.status = status;
    if (status !== "active") for (const t of Object.values(this.kitchen.state.tasks)) if (t.goal === id && (status === "cancelled" ? !["done", "cancelled"].includes(t.status) : t.status === "running")) status === "cancelled" ? this.cancel({ id: t.id }) : this.pause({ id: t.id });
    this.kitchen.emit({ type: "system", from: "chef", to: "board", goal: id, text: `${id} ${status}` });
    this.kitchen.changed();
    return g;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const id of this.running.keys()) this.kill(id);
  }
}
