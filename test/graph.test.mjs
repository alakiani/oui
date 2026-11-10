import test from "node:test";
import assert from "node:assert/strict";
import { dependentsOf, displayState, graphProblem, heldUpBy, ranks, startOrder } from "../src/graph.mjs";

const T = (id, needs = [], status = "todo", extra = {}) => ({ id, needs, status, goal: "G1", createdAt: Number(id.slice(1)), ...extra });
const map = (tasks) => new Map(tasks.map((t) => [t.id, t]));

test("a plan must be a graph without loops or dangling needs", () => {
  assert.equal(graphProblem([T("T1"), T("T2", ["T1"]), T("T3", ["T1", "T2"])]), null);
  assert.match(graphProblem([T("T1", ["T9"])]), /T9, which does not exist/);
  assert.match(graphProblem([T("T1", ["T1"])]), /needs itself/);
  assert.match(graphProblem([T("T1", ["T3"]), T("T2", ["T1"]), T("T3", ["T2"])]), /dependency loop: T1 → T3 → T2 → T1/);
});

test("ranks put each ticket one column after the deepest thing it needs", () => {
  const r = ranks([T("T1"), T("T2"), T("T3", ["T1", "T2"]), T("T4", ["T3"]), T("T5", ["T1"])]);
  assert.deepEqual(Object.fromEntries(r), { T1: 0, T2: 0, T3: 1, T4: 2, T5: 1 });
});

test("what the board calls a ticket depends on its needs and its asks", () => {
  const tasks = [T("T1", [], "done"), T("T2", [], "running"), T("T3", ["T1"]), T("T4", ["T2"]), T("T5", [], "blocked"), T("T6", [], "blocked"), T("T7", [], "failed"), T("T8", ["T7"])];
  const byId = map(tasks);
  const asks = [
    { task: "T5", to: "chef", status: "open" },
    { task: "T6", to: "sous", status: "open" },
  ];
  const goal = { status: "active" };
  const state = (id) => displayState(byId.get(id), byId, asks, goal);
  assert.equal(state("T3"), "ready");
  assert.equal(state("T4"), "waiting");
  assert.equal(state("T5"), "needs_you");
  assert.equal(state("T6"), "with_sous");
  assert.equal(state("T8"), "stuck");
  assert.equal(displayState(byId.get("T3"), byId, asks, { status: "paused" }), "paused");
});

test("ready tickets start in order: priority, then whatever unblocks the most, then the oldest", () => {
  const tasks = [T("T1"), T("T2"), T("T3", ["T2"]), T("T4", ["T3"]), T("T5", [], "todo", { priority: 5 }), T("T6", ["T1"], "todo")];
  const order = startOrder(tasks, map(tasks), { G1: { status: "active" } }).map((t) => t.id);
  assert.deepEqual(order, ["T5", "T2", "T1"]);
  assert.deepEqual(startOrder(tasks, map(tasks), { G1: { status: "paused" } }), []);
});

test("an ask is weighed by how much work waits behind it", () => {
  const tasks = [T("T1", [], "blocked"), T("T2", ["T1"]), T("T3", ["T2"]), T("T4", ["T1"], "done"), T("T5")];
  assert.deepEqual([...dependentsOf(tasks).get("T1")].sort(), ["T2", "T3", "T4"]);
  assert.equal(heldUpBy("T1", tasks, map(tasks)), 3);
  assert.equal(heldUpBy("T5", tasks, map(tasks)), 1);
  assert.equal(heldUpBy(null, tasks, map(tasks)), 0);
});

// ---- what agents are told: every blank in a prompt must be filled
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("briefs and judgement-call prompts render with nothing left blank", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oui-brief-"));
  process.env.OUI_HOME = home;
  const { Kitchen } = await import("../src/kitchen.mjs");
  const { cookBrief, cookContract, rolePrompt } = await import("../src/brief.mjs");
  const kitchen = new Kitchen();
  const chef = { role: "chef" };
  kitchen.projectAdd({ path: home, name: "api" });
  kitchen.remember({ text: "Always squash-merge" });
  const plan = kitchen.plan({ goal: { title: "Rate-limit the API", detail: "Stop noisy clients.", project: "api" }, tickets: [{ key: "a", title: "Limiter", brief: "Build it.", accept: ["tests pass"] }, { key: "b", title: "Wire it", needs: ["a"], brief: "Use it." }] }, chef);
  const [a, b] = plan.tasks.map((t) => kitchen.state.tasks[t.id]);
  Object.assign(a, { workdir: home, branch: "oui/G1/T1-limiter", report: { summary: "Built.", handoff: "Call limiter().", evidence: "14 passing" } });
  Object.assign(b, { workdir: home });
  kitchen.state.goals[plan.goal].branch = "oui/G1-rate-limit";
  const ask = kitchen.askCreate({ title: "Per key or per IP?", options: ["Key", "IP"], pick: "Key", body: "Decides the bucket." }, { role: "cook", task: a.id });
  const texts = {
    brief: cookBrief(kitchen, b),
    contract: cookContract(),
    plan: rolePrompt("plan", kitchen, { goal: kitchen.state.goals[plan.goal] }),
    triage: rolePrompt("triage", kitchen, { ask }),
    review: rolePrompt("review", kitchen, { task: a }),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(!/\{\{|\}\}/.test(text), `${name} has an unfilled placeholder`);
  }
  assert.match(texts.brief, /# T2: Wire it/);
  assert.match(texts.brief, /T1 “Limiter”: Call limiter\(\)\./, "the handoff of what it needs is in the brief");
  assert.match(texts.brief, /Always squash-merge/);
  assert.match(texts.triage, /Ticket T1 "Limiter"/);
  assert.match(texts.triage, /The cook asks \(A1\): Per key or per IP\?/);
  assert.match(texts.review, /ticket T1 "Limiter" is finished/);
  assert.match(texts.review, /oui verdict T1 pass/);
  assert.match(texts.plan, /"goalId": "G1"/);
  assert.match(texts.plan, /A ticket is a dish, not an ingredient/, "the planner is told how this kitchen writes tickets");
  fs.rmSync(home, { recursive: true, force: true });
});

test("what the chef decided for a goal reaches the cooks, the triage and the inspector", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oui-decide-"));
  process.env.OUI_HOME = home;
  const { Kitchen } = await import("../src/kitchen.mjs");
  const { cookBrief, rolePrompt } = await import("../src/brief.mjs");
  const kitchen = new Kitchen();
  const chef = { role: "chef" };
  kitchen.projectAdd({ path: home, name: "api" });
  const plan = kitchen.plan({ goal: { title: "Rate-limit the API", detail: "Stop noisy clients.", project: "api" }, tickets: [{ key: "q", kind: "decide", title: "Count per key or per IP?", brief: "It sets the bucket key.", options: ["Per key", "Per IP"], pick: "Per key" }, { key: "open", kind: "decide", title: "Which tier is the default?" }, { key: "wire", title: "Wire it", needs: ["q"], brief: "Use it." }, { key: "docs", title: "Document it", brief: "Write it up." }] }, chef);
  const [q, open, wire, docs] = plan.tasks.map((t) => kitchen.state.tasks[t.id]);
  assert.deepEqual([q.kind, q.options, q.pick, q.decision], ["decide", ["Per key", "Per IP"], "Per key", null]);
  assert.equal(wire.options, undefined, "only a question carries options");
  Object.assign(q, { status: "done", decision: "Per IP", report: { summary: "Decided: Per IP", handoff: "The chef decided: Per IP" } });
  for (const t of [wire, docs]) Object.assign(t, { workdir: home });
  const ask = kitchen.askCreate({ title: "Which header carries the key?" }, { role: "cook", task: wire.id });
  for (const text of [cookBrief(kitchen, wire), cookBrief(kitchen, docs), rolePrompt("triage", kitchen, { ask }), rolePrompt("review", kitchen, { task: wire })]) {
    assert.match(text, /## Decisions for this goal\n- Count per key or per IP\? → Per IP\n- Which tier is the default\? → still with the chef/);
    assert.ok(!/\{\{|\}\}/.test(text));
  }
  assert.ok(!/## What came before/.test(cookBrief(kitchen, wire)), "a decision is not repeated as a handoff");
  assert.ok(!new RegExp(`${open.id} “`).test(cookBrief(kitchen, docs)), "a question is not listed as a cook to talk to");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the chef's own prompt files win over the built-in ones, one file or one role at a time", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oui-prompts-"));
  process.env.OUI_HOME = home;
  const { Kitchen } = await import("../src/kitchen.mjs");
  const { PROMPTS, builtinPrompt, cookContract, ownPrompt, promptFile, rolePrompt, sousManual } = await import("../src/brief.mjs");
  const kitchen = new Kitchen();
  kitchen.projectAdd({ path: home, name: "api" });
  const plan = kitchen.plan({ goal: { title: "A goal", detail: "Do it.", project: "api" }, tickets: [{ key: "a", title: "One", brief: "x" }] }, { role: "chef" });
  const a = kitchen.state.tasks[plan.tasks[0].id];
  Object.assign(a, { workdir: home, branch: "oui/G1/T1-one" });
  const goal = kitchen.state.goals[plan.goal];
  goal.branch = "oui/G1-a-goal";

  // Out of the box: every file is the built-in one, and the manual carries the ticket rules and the chef's preferences.
  for (const name of Object.keys(PROMPTS)) assert.equal(promptFile(name), builtinPrompt(name));
  const manual = sousManual("- Skip the questions on small goals");
  assert.ok(!/\{\{|\}\}/.test(manual), "the sous chef's manual has an unfilled placeholder");
  assert.match(manual, /## Mise en place/);
  assert.match(manual, /A ticket is a dish, not an ingredient/);
  assert.match(manual, /## The chef's standing preferences\nThese come before anything else on this page\.\n- Skip the questions on small goals/);
  assert.ok(!/standing preferences\n/.test(sousManual()), "no preferences, no empty heading");

  // The chef's own files are picked up on the next use, without a restart.
  fs.mkdirSync(path.join(home, "prompts"));
  fs.writeFileSync(ownPrompt("cook.md"), "You cook the way this house cooks.\n");
  fs.writeFileSync(ownPrompt("tickets.md"), "- One ticket per pull request.\n");
  fs.writeFileSync(ownPrompt("roles.md"), "## review\n\nHouse review of {{ticket}}: read `git diff {{base}}...{{branch}}`, then give a verdict.\n");
  assert.equal(cookContract(), "You cook the way this house cooks.\n");
  assert.equal(promptFile("cook.md"), ownPrompt("cook.md"));
  assert.match(sousManual(), /- One ticket per pull request\./);
  assert.match(rolePrompt("plan", kitchen, { goal }), /- One ticket per pull request\./, "the planner follows the chef's ticket rules too");
  assert.match(rolePrompt("plan", kitchen, { goal }), /You are the sous chef in Oui Chef's kitchen, planning one goal/, "a role the chef's file leaves out stays built-in");
  assert.equal(rolePrompt("review", kitchen, { task: a }), "House review of T1: read `git diff oui/G1-a-goal...oui/G1/T1-one`, then give a verdict.");

  // An empty file is not an instruction to say nothing.
  fs.writeFileSync(ownPrompt("cook.md"), "\n");
  assert.equal(promptFile("cook.md"), builtinPrompt("cook.md"));
  assert.match(cookContract(), /You are a line cook/);
  fs.rmSync(home, { recursive: true, force: true });
});
