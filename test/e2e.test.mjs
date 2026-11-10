// The whole loop with stand-in agents: a real daemon, real hooks, the real oui
// CLI and real git, in a throwaway home. Only the model is scripted.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { PLAN, makeDemo, scenario } from "../src/demo.mjs";
import { buildBoard } from "../src/board.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oui-test-"));
const script = scenario({ slow: 0.02 });
delete script.tasks.profile;
// A cook that tries to approve its own held command, then does as it is told.
script.tasks.sneaky = [{ run: "kubectl --context prod-eu delete deploy/api -n shop" }, { run: "oui approve A1" }, { run: "cat $OUI_HOME/daemon.json" }, { run: 'oui done --summary "Left production alone, as told."' }];
// A cook that just stops talking.
script.tasks.silent = [{ say: "Hm." }, { end: true }, { say: "Still thinking." }, { end: true }, { say: "…" }, { end: true }, { run: 'oui done --summary "Finally."' }];
// A cook whose first report does not pass the project's check.
script.tasks.sloppy = [{ write: "broken.txt", content: "x\n" }, { run: 'git add -A && git commit -qm "wip"' }, { run: 'oui done --summary "Done, I think."' }, { end: true }, { run: 'git rm -q broken.txt && git commit -qm "fix"' }, { run: 'oui done --summary "Removed the file the check rejects."' }];

script.tasks.feature = [{ write: "feature.txt", content: "new\n" }, { run: 'git add -A && git commit -qm "Add the feature"' }, { run: 'oui done --summary "Added the feature."' }];
script.tasks.deploy = [{ run: "git -C {repo} log --format=%s main | grep -q 'Add the feature'", must: true }, { run: "test -f feature.txt", must: true }, { run: 'oui done --summary "Deployed from main."' }];

const demo = makeDemo(dir, { scenario: script, port: 0, config: { maxNudges: 2 } });
process.env.OUI_STUB_REPO = demo.repo;
Object.assign(process.env, demo.env);
const { runDaemon } = await import("../src/daemon.mjs");
const { kitchen, expo, shutdown } = await runDaemon({ port: 0 });
const who = { role: "chef" };
const board = () => buildBoard(kitchen, expo.running);
const git = (...args) => spawnSync("git", ["-C", demo.repo, ...args], { encoding: "utf8" }).stdout.trim();

async function until(what, check, ms = 20000) {
  const start = Date.now();
  for (;;) {
    const got = check();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}\n${JSON.stringify(board().tasks.map((t) => [t.id, t.state, t.line]))}\nasks ${JSON.stringify(board().asks.map((a) => [a.id, a.kind, a.title]))}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const state = (id) => board().tasks.find((t) => t.id === id)?.state;
const askFor = (task, kind) => board().asks.find((a) => a.task === task && (!kind || a.kind === kind));

test.after(() => {
  shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a goal runs in dependency order and reaches the chef only for what is theirs", async () => {
  kitchen.projectAdd({ path: demo.repo, landing: "local" });
  const g1 = kitchen.plan(PLAN[0], who);
  const [limiter, limits, wire, staging, prod] = g1.tasks.map((t) => t.id);

  // Two tickets start at once; the three behind them wait, in order.
  assert.deepEqual(board().tasks.find((t) => t.id === wire).waitingOn, [limiter, limits]);
  assert.deepEqual(board().goals[0].total, 5);

  // The cook's question goes to the sous chef, who passes it up reworded.
  const question = await until("the question to reach the chef", () => askFor(limits, "question"));
  assert.equal(question.viaSous, true);
  assert.match(question.title, /per API key, per IP, or key with IP fallback/);
  assert.equal(question.holds, 4, "the question holds up its own ticket and the three behind it");
  assert.equal(state(limits), "needs_you");
  await until("the independent ticket to finish meanwhile", () => state(limiter) === "done");
  assert.equal(state(wire), "waiting");

  // One answer, and the rest of the chain runs without the chef until production.
  kitchen.askAnswer({ id: question.id, text: "Per key, falling back to IP" }, who);
  const hold = await until("the production rollout to be held", () => askFor(prod, "approval"));
  assert.equal(state(staging), "done");
  assert.equal(hold.rule, "kube.change.prod");
  assert.equal(hold.command, "kubectl --context prod-eu apply -f k8s/api.yaml -n shop");
  assert.match(hold.undo[0].steps[0], /kubectl --context prod-eu -n shop apply -f <checkpoint>\/0-before\.json/);

  // Staging was changed without asking, and recorded with a checkpoint that can restore it.
  const staged = kitchen.actions({}).find((a) => a.task === staging && a.decision === "ran");
  assert.equal(staged.rule, "kube.change");
  const checkpoint = JSON.parse(fs.readFileSync(path.join(kitchen.checkpointDir(staged), "0-before.json"), "utf8"));
  assert.equal(checkpoint.items[0].spec.replicas, 3);
  assert.equal(checkpoint.items[0].metadata.resourceVersion, undefined, "live-only fields are stripped so it can be re-applied");
  assert.equal(kitchen.undo({ id: staged.id }).runnable, true);
  const undone = kitchen.undo({ id: staged.id, run: true });
  assert.equal(undone.ok, true);
  assert.match(undone.results[0].step, /kubectl --context staging-eu -n shop apply -f .*0-before\.json/);

  // The message from one cook to the next was delivered on the board.
  assert.ok(kitchen.feed.some((e) => e.type === "msg" && e.from === `cook:${wire}` && e.to === `cook:${staging}`));

  // Approval resumes the cook, which runs exactly the held command and finishes.
  kitchen.askApprove({ id: hold.id, note: "window is open" }, who);
  await until("production to finish", () => state(prod) === "done");
  assert.ok(kitchen.actions({}).some((a) => a.task === prod && a.decision === "approved"));

  // Each build ticket was checked by the inspector before it merged.
  for (const id of [limiter, limits, wire]) assert.equal(kitchen.state.tasks[id].review?.verdict, "pass", `${id} was reviewed`);
  assert.ok(kitchen.feed.some((e) => e.type === "review" && e.from === "inspector"));

  // Every build ticket was merged into the goal branch; the base is untouched until the chef lands it.
  const land = await until("the landing to be offered", () => board().asks.find((a) => a.kind === "land" && a.goal === g1.goal));
  assert.equal(git("log", "--oneline", "main").split("\n").length, 1);
  assert.ok(git("log", "--oneline", kitchen.state.goals[g1.goal].branch).includes("Apply limiter to public routes"));
  const before = git("rev-parse", "main");
  kitchen.askApprove({ id: land.id }, who);
  await until("the goal to land", () => kitchen.state.goals[g1.goal].status === "done");
  assert.ok(fs.existsSync(path.join(demo.repo, "src", "limiter.js")), "main is checked out and now has the work");

  // And landing can be undone.
  const landed = kitchen.actions({}).find((a) => a.rule === "oui.land");
  assert.equal(kitchen.undo({ id: landed.id, run: true }).ok, true);
  assert.equal(git("rev-parse", "main"), before);
});

test("access requests go straight to the chef, and pipelines are recorded", async () => {
  const g = kitchen.plan(PLAN[1], who);
  const [, ci] = g.tasks.map((t) => t.id);
  const need = await until("the access request", () => askFor(ci, "access"));
  assert.equal(need.viaSous, false);
  assert.match(need.body, /gh auth refresh -s workflow/);
  kitchen.askAnswer({ id: need.id, text: "Refreshed." }, who);
  await until("CI ticket to finish", () => state(ci) === "done");
  assert.ok(kitchen.actions({}).some((a) => a.task === ci && a.rule === "forge.pipeline.run" && a.decision === "ran"));
});

test("a cook cannot approve itself, and a denial sticks", async () => {
  const g = kitchen.plan({ goal: { title: "Clean up", project: demo.repo }, tasks: [{ key: "sneaky", kind: "ops", title: "Remove the old deployment", brief: "x" }] }, who);
  const id = g.tasks[0].id;
  const hold = await until("the delete to be held", () => askFor(id, "approval"));
  kitchen.askDeny({ id: hold.id, note: "not today" }, who);
  await until("the ticket to finish without it", () => state(id) === "done");
  const mine = kitchen.actions({ task: id, limit: 20 });
  assert.ok(!mine.some((a) => a.decision === "ran" || a.decision === "approved"), "nothing risky ran");
  assert.equal(mine.filter((a) => a.rule === "oui.tamper" && a.decision === "refused").length, 2, "oui approve and reading daemon.json were both refused");
  assert.equal(kitchen.state.asks[hold.id].status, "denied");
});

test("a cook that stops without reporting is nudged, then handed to the chef", async () => {
  const g = kitchen.plan({ goal: { title: "Quiet one", project: demo.repo }, tasks: [{ key: "silent", kind: "scout", title: "Think about it", brief: "x" }] }, who);
  const id = g.tasks[0].id;
  const stuck = await until("the chef to be told", () => askFor(id, "stuck"));
  assert.match(stuck.title, /stopped without finishing or asking/);
  assert.equal(kitchen.state.tasks[id].turns, 3, "one turn plus two nudges");
  kitchen.askAnswer({ id: stuck.id, text: "Tell it to continue" }, who);
  await until("it to finish", () => state(id) === "done");
});

test("work that fails the project's check is sent back, not merged", async () => {
  kitchen.projectAdd({ path: demo.repo, landing: "local", verify: ["test ! -e broken.txt"], replace: true });
  const g = kitchen.plan({ goal: { title: "Careful one", project: demo.repo }, tasks: [{ key: "sloppy", title: "Tidy up", brief: "x" }] }, who);
  const id = g.tasks[0].id;
  await until("it to pass on the second try", () => state(id) === "done");
  assert.equal(kitchen.state.tasks[id].attempt, 1);
  assert.ok(kitchen.feed.some((e) => e.task === id && /sent back: A required check failed/.test(e.text)));
  assert.ok(!git("ls-tree", "-r", "--name-only", kitchen.state.goals[g.goal].branch).includes("broken.txt"));
});

test("a land step mid-plan puts the work on the base branch before what follows", async () => {
  kitchen.projectAdd({ path: demo.repo, landing: "local", verify: [], replace: true });
  const g = kitchen.plan({ goal: { title: "Ship and deploy", project: demo.repo }, tasks: [{ key: "feature", title: "Add the feature", brief: "x" }, { key: "land", kind: "land", title: "Land before deploying", needs: ["feature"] }, { key: "deploy", kind: "ops", title: "Deploy from main", needs: ["land"], brief: "x" }] }, who);
  const [feature, land, deploy] = g.tasks.map((t) => t.id);
  const ask = await until("the land step to ask", () => askFor(land, "land"));
  assert.equal(state(feature), "done");
  assert.equal(state(deploy), "waiting");
  assert.ok(!git("log", "--format=%s", "main").includes("Add the feature"), "nothing reaches main before the chef says so");
  kitchen.askApprove({ id: ask.id }, who);
  // The deploy cook's first command fails unless main already has the feature.
  await until("the deploy to finish", () => state(deploy) === "done");
  assert.ok(git("log", "--format=%s", "main").includes("Add the feature"));
  await until("the goal to close without a second landing", () => kitchen.state.goals[g.goal].status === "done");
  assert.ok(!board().asks.some((a) => a.goal === g.goal), "there was nothing left to land at the end");
});

test("the chef's token is needed to decide; an agent's token is not enough", async () => {
  const url = `http://127.0.0.1:${kitchen.port}`;
  const call = (method, params, token) => fetch(`${url}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", "x-oui-token": token ?? "" }, body: JSON.stringify({ method, params }) }).then((r) => r.status);
  assert.equal(await call("service", { on: false }, ""), 401);
  assert.equal(await call("service", { on: false }, kitchen.token("cook", "T1")), 403);
  assert.equal(await call("approve", { id: "A1" }, kitchen.token("sous", "T1")), 403);
  assert.equal(await call("board", {}, kitchen.token("cook", "T1")), 200);
  const rebound = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: kitchen.port, path: "/api/board", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode)));
  assert.equal(rebound, 403, "a hostname rebound to localhost is refused");
  const crossSite = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: kitchen.port, path: "/api/board", headers: { origin: "https://evil.example" } }, (res) => resolve(res.statusCode)));
  assert.equal(crossSite, 403, "a request from another site's page is refused");
  assert.equal((await fetch(`${url}/act?m=service&on=&t=wrong`)).status, 401);
  assert.equal(kitchen.state.service.on, true);
});
