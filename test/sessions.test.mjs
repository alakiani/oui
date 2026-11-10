// Cooks as sessions in terminals. The Herdr backend is driven against a
// stand-in `hc` that records every call; the tmux backend runs in a real tmux
// when one is installed. The agents are scripted; everything else is real.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PLAN, makeDemo, scenario } from "../src/demo.mjs";
import { buildBoard } from "../src/board.mjs";
import { resolve } from "../src/sessions/index.mjs";
import * as tmux from "../src/sessions/tmux.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oui-sessions-"));
const script = scenario({ slow: 0.02 });
const demo = makeDemo(dir, { scenario: script, port: 0, hc: true, config: { sessions: "herdr" } });
Object.assign(process.env, demo.env);
const { runDaemon } = await import("../src/daemon.mjs");
const { kitchen, expo, shutdown } = await runDaemon({ port: 0 });
const chef = { role: "chef" };
const board = () => buildBoard(kitchen, expo.running);
const calls = () => fs.readFileSync(path.join(dir, "hc", "calls.log"), "utf8").split("\n").filter(Boolean);
const state = (id) => board().tasks.find((t) => t.id === id)?.state;
const askFor = (task, kind) => board().asks.find((a) => a.task === task && (!kind || a.kind === kind));
async function until(what, check, ms = 25000) {
  const start = Date.now();
  for (;;) {
    const got = check();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}\n${JSON.stringify(board().tasks.map((t) => [t.id, t.state, t.line]))}\n${calls().slice(-12).join("\n")}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

test.after(() => {
  shutdown();
  for (const f of fs.readdirSync(path.join(dir, "hc")).filter((x) => x.endsWith(".json"))) {
    try {
      process.kill(-JSON.parse(fs.readFileSync(path.join(dir, "hc", f), "utf8")).pid, "SIGKILL");
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the backend is chosen by config, and Herdr comes first when it is installed", () => {
  assert.equal(expo.backend.name, "herdr");
  assert.equal(resolve("none"), null);
  assert.equal(resolve("auto").name, "herdr", "hc is on PATH in this test, so auto picks Herdr");
  assert.throws(() => resolve("screen"), /Unknown sessions backend/);
  assert.equal(board().service.sessions, "herdr");
});

test("with Herdr, each cook is a terminal in its goal's space, and answers are typed into it", async () => {
  kitchen.projectAdd({ path: demo.repo, landing: "local" });
  const g = kitchen.plan(PLAN[0], chef);
  const [limiter, limits, wire, staging, prod] = g.tasks.map((t) => t.id);

  // Two cooks start: two hc terminals, named for their tickets, labelled into the goal's space.
  const question = await until("the question", () => askFor(limits, "question"));
  const started = calls().filter((c) => c.startsWith("run "));
  assert.equal(started.length, 2);
  assert.match(started.find((c) => c.includes("--name oui-t1 ")), /^run --bg --no-parent --name oui-t1 --cwd \S+worktrees\/shop-api\/T1 --label oui\.ticket=T1 --label herdr\.tab=oui-t1 --label herdr\.space=oui-g1 --label oui\.goal=G1 -- \S+ \S+oui\.mjs station T1 [0-9a-f]{24} \d+$/);
  assert.ok(!started.some((c) => /OUI_TOKEN|cook\.T\d+\./.test(c)), "nothing secret is on a terminal's command line");
  assert.deepEqual(kitchen.state.tasks[limits].terminal.handle, "oui-t2");
  assert.deepEqual(board().tasks.find((t) => t.id === limits).terminal, { backend: "herdr", handle: "oui-t2" });

  // The cook stops to wait, a moment after its question is on the board. Its terminal is still there; the answer is typed into it.
  await until("the cook to stop and wait", () => state(limits) === "needs_you");
  kitchen.askAnswer({ id: question.id, text: "Per key, falling back to IP" }, chef);
  await until("the answer to be typed in", () => calls().some((c) => c.startsWith("send oui-t2 ") && c.includes("Per key, falling back to IP")));
  assert.equal(calls().filter((c) => c.startsWith("run ") && c.includes("--name oui-t2 ")).length, 1, "the same terminal is reused, not restarted");

  // The production rollout is held at the pass; approval is typed into that cook's terminal.
  const hold = await until("the production hold", () => askFor(prod, "approval"));
  assert.equal(hold.rule, "kube.change.prod");
  kitchen.askApprove({ id: hold.id, note: "window is open" }, chef);
  await until("production to finish", () => state(prod) === "done");
  // The approval reaches the cook either typed into its terminal or, if it was still winding down, at its stop hook.
  assert.ok(kitchen.actions({}).some((a) => a.task === prod && a.decision === "approved"), "the held command ran once approved");
  for (const id of [limiter, limits, wire, staging, prod]) assert.equal(state(id), "done");
  assert.equal(kitchen.state.tasks[wire].review?.verdict, "pass");

  // A finished ticket's terminal is closed.
  await until("terminals to be closed", () => ["oui-t1", "oui-t2", "oui-t3", "oui-t4", "oui-t5"].every((n) => calls().includes(`kill ${n}`)));
  assert.equal(board().tasks.find((t) => t.id === prod).terminal, null);
});

test("a terminal someone closes is noticed, and the cook comes back in a new one on the same conversation", async () => {
  const g = kitchen.plan(PLAN[1], chef);
  const [, ci] = g.tasks.map((t) => t.id);
  const need = await until("the access request", () => askFor(ci, "access"));
  // The ask is on the board a moment before the cook ends its turn. Close the terminal of a cook
  // that has stopped to wait, which is what this test is about, not one still in the middle of asking.
  await until("the cook to stop and wait", () => state(ci) === "needs_you");
  const handle = kitchen.state.tasks[ci].terminal.handle;
  const session = kitchen.state.tasks[ci].session;
  spawnSync(path.join(dir, "bin", "hc"), ["kill", handle], { env: process.env });
  kitchen.askAnswer({ id: need.id, text: "Refreshed." }, chef);
  await until("the cook to finish", () => state(ci) === "done");
  const reopened = calls().filter((c) => c.startsWith("run ") && c.includes(`--name ${handle} `));
  assert.equal(reopened.length, 2, "a second terminal was opened for the same ticket");
  assert.equal(kitchen.state.tasks[ci].session, session, "on the same conversation");
});

test("with tmux, each cook is a window in one session", { skip: !tmux.available() && "tmux is not installed" }, async () => {
  const name = `oui-test-${process.pid}`;
  process.env.OUI_TMUX_SESSION = name;
  const before = expo.backend;
  expo.backend = tmux;
  try {
    const g = kitchen.plan({ goal: { title: "Second service", project: demo.repo }, tickets: [{ key: "ci-run", kind: "ops", title: "Run CI again", brief: "x" }] }, chef);
    const id = g.tasks[0].id;
    const need = await until("the access request", () => askFor(id, "access"));
    const pane = kitchen.state.tasks[id].terminal.handle;
    assert.match(pane, /^%\d+$/);
    const windows = execFileSync("tmux", ["list-windows", "-t", name, "-F", "#{window_name}"], { encoding: "utf8" });
    assert.match(windows, new RegExp(`${id} Run CI again`));
    kitchen.askAnswer({ id: need.id, text: "Refreshed.\nSecond line of the same message." }, chef);
    await until("the cook to finish", () => state(id) === "done");
    assert.equal(await tmux.alive(pane), false, "its window is closed when the ticket is done");
  } finally {
    expo.backend = before;
    spawnSync("tmux", ["kill-session", "-t", name]);
  }
});
