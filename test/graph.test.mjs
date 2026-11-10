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
  fs.rmSync(home, { recursive: true, force: true });
});
