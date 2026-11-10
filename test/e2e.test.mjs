// The whole loop with stand-in agents: a real daemon, real hooks, the real oui
// CLI and real git, in a throwaway home. Only the model is scripted.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLAN, makeDemo, scenario } from "../src/demo.mjs";
import { buildBoard } from "../src/board.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oui-test-"));
const script = scenario({ slow: 0.02 });
delete script.tasks.profile;
// A cook that tries to approve its own held command, then does as it is told.
script.tasks.sneaky = [{ run: "kubectl --context prod-eu delete deploy/api -n shop" }, { run: "oui approve A1" }, { run: "cat $OUI_HOME/daemon.json" }, { run: 'oui done --summary "Left production alone, as told."' }];
// A cook that just stops talking.
// Each turn it stops, is told to report, and stops again without doing so.
script.tasks.silent = [...Array.from({ length: 6 }, () => [{ say: "Hm." }, { end: true }]).flat(), { run: 'oui done --summary "Finally."' }];
// A cook whose first report does not pass the project's check.
script.tasks.sloppy = [{ write: "broken.txt", content: "x\n" }, { run: 'git add -A && git commit -qm "wip"' }, { run: 'oui done --summary "Done, I think."' }, { end: true }, { run: 'git rm -q broken.txt && git commit -qm "fix"' }, { run: 'oui done --summary "Removed the file the check rejects."' }];

// A cook that gives up, and finishes once the chef tells it where to look.
script.tasks.stuck = [{ run: 'oui fail "The schema file is missing."' }, { end: true }, { run: 'oui done --summary "Used the schema the chef pointed to."' }];
// A cook with a question that has options.
script.tasks.picky = [{ run: 'oui ask "Which one?" --option "One" --option "Two"' }, { end: true }, { run: 'oui done --summary "Went with what the chef picked."' }];

// A cook whose file name the house inspector does not like, until it is renamed.
script.tasks.styled = [{ write: "notes.txt", content: "x\n" }, { run: 'git add -A && git commit -qm "Add notes"' }, { run: 'oui done --summary "Added the notes file."' }, { end: true }, { run: 'git mv notes.txt renamed.txt && git commit -qm "Rename"' }, { run: 'oui done --summary "Renamed as the house asks."' }];
// An inspector of the chef's own. It looks at one thing only.
script.roles["review: standards"] = [{ run: 'test -f renamed.txt && oui verdict {ticket} pass --notes "Named for what it holds." || oui verdict {ticket} changes --notes "Name the file after what it holds."' }];
// The sous chef planning a goal by itself: two tickets, and a note for the chef.
const PLANNER = [{ run: `oui plan - <<'EOF'\n{ "goalId": "{goal}", "goal": { "title": "Two steps", "note": "Cut in two. Assumed nothing else changes." }, "tickets": [ { "key": "first", "kind": "scout", "title": "First step", "brief": "x" }, { "key": "second", "kind": "scout", "title": "Second step", "brief": "x", "needs": ["first"] } ] }\nEOF` }];

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
// The chef at a terminal. Not spawnSync: the daemon it talks to lives in this process.
const oui = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/oui.mjs", import.meta.url)), ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
const state = (id) => board().tasks.find((t) => t.id === id)?.state;
// What the stand-in for a judgement call does from its next run on.
const setRole = (name, steps) => {
  const all = JSON.parse(fs.readFileSync(demo.script, "utf8"));
  all.roles[name] = steps;
  fs.writeFileSync(demo.script, JSON.stringify(all));
};
const ticketsOf = (goal) => Object.values(kitchen.state.tasks).filter((t) => t.goal === goal);
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

test("a failed ticket is retried with the chef's own words as guidance", async () => {
  const g = kitchen.plan({ goal: { title: "Needs a pointer", project: demo.repo }, tasks: [{ key: "stuck", kind: "scout", title: "Read the schema", brief: "x" }] }, who);
  const id = g.tasks[0].id;
  const ask = await until("the failure to reach the chef", () => askFor(id, "stuck"));
  assert.deepEqual(ask.options, ["Retry", "Accept as done", "Cancel ticket"]);
  kitchen.askAnswer({ id: ask.id, text: "It is in db/schema.sql" }, who);
  await until("the retry to finish", () => state(id) === "done");
});

test("oui answer with a number picks that option", async () => {
  const g = kitchen.plan({ goal: { title: "A choice", project: demo.repo }, tasks: [{ key: "picky", kind: "scout", title: "Pick one", brief: "x" }] }, who);
  const id = g.tasks[0].id;
  const ask = await until("the question to reach the chef", () => askFor(id, "question"));
  const res = await oui("answer", ask.id, "2");
  assert.equal(res.code, 0, res.out);
  assert.equal(kitchen.state.asks[ask.id].answer, ask.options[1]);
  assert.match(res.out, new RegExp(`${ask.id} answered: ${ask.options[1]}`));
  await until("the cook to carry on", () => state(id) === "done");
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

  // Undoing the landing puts main back and leaves the chef's own uncommitted edits alone.
  const mine = path.join(demo.repo, "src", "app.js");
  const before = fs.readFileSync(mine, "utf8");
  fs.writeFileSync(mine, `${before}// the chef is halfway through something\n`);
  const landing = kitchen.actions({}).find((a) => a.rule === "oui.land" && a.goal === g.goal);
  const undone = kitchen.undo({ id: landing.id, run: true });
  assert.ok(undone.ok, JSON.stringify(undone.results));
  assert.ok(!git("log", "--format=%s", "main").includes("Add the feature"), "main is back where it was");
  assert.match(fs.readFileSync(mine, "utf8"), /halfway through something/, "the chef's edit survived");
  fs.writeFileSync(mine, before);
});

test("a question in the plan reaches the pass at once and holds only the tickets that need its answer", async () => {
  // Every cook is busy: a question needs none, so it must not wait for one.
  const max = kitchen.config.maxCooks;
  kitchen.config.maxCooks = 0;
  const g = kitchen.plan(
    {
      goal: { title: "Ask first", project: demo.repo },
      tasks: [
        { key: "free", kind: "scout", title: "Look around", brief: "x" },
        { key: "which", kind: "decide", title: "Count limits per key or per IP?", brief: "It sets the bucket key.", options: ["Per key", "Per IP"], pick: "Per key" },
        { key: "after", kind: "scout", title: "Use the answer", brief: "x", needs: ["which"] },
      ],
    },
    who,
  );
  const [free, which, after] = g.tasks.map((t) => t.id);
  const ask = await until("the question to reach the pass", () => askFor(which, "decision"));
  assert.deepEqual([ask.title, ask.body, ask.options, ask.pick], ["Count limits per key or per IP?", "It sets the bucket key.", ["Per key", "Per IP"], "Per key"]);
  assert.equal(ask.holds, 1, "the one ticket behind it; the question itself is not work");
  assert.equal(state(which), "needs_you");
  assert.equal(board().tasks.find((t) => t.id === which).line, "your call; the plan would pick: Per key");
  assert.equal(state(free), "ready", "no cook was free, and the question did not need one");

  // The rest of the plan cooks while the question is open.
  kitchen.config.maxCooks = max;
  expo.kick();
  await until("the independent ticket to finish meanwhile", () => state(free) === "done");
  assert.equal(state(after), "waiting");
  assert.equal(state(which), "needs_you");

  // It is a question, not an approval.
  assert.throws(() => kitchen.askDeny({ id: ask.id }, who), /is a question: answer it/);
  assert.throws(() => kitchen.askApprove({ id: ask.id }, who), /is a question: answer it instead/);

  // The answer finishes the ticket, and the cook behind it is told what was decided.
  const res = await oui("answer", ask.id, "2");
  assert.equal(res.code, 0, res.out);
  assert.equal(state(which), "done");
  assert.equal(kitchen.state.tasks[which].decision, "Per IP");
  await until("the ticket behind it to run", () => state(after) === "done");
  const brief = fs.readFileSync(path.join(demo.home, "tickets", after, "brief.md"), "utf8");
  assert.match(brief, /## Decisions for this goal\n- Count limits per key or per IP\? → Per IP/);
  assert.match((await oui("show", which)).out, /Options: 1\) Per key {3}2\) Per IP\nThe plan would pick: Per key[\s\S]*Report: Decided: Per IP/);
  await until("the goal to close", () => kitchen.state.goals[g.goal].status === "done");

  // A question can be added to a goal later, from the terminal.
  const added = await oui("ticket", "add", "--goal", g.goal, "--kind", "decide", "--title", "Ship behind a flag?", "--option", "Yes", "--option", "No", "--pick", "Yes");
  assert.equal(added.code, 0, added.out);
  const later = await until("the added question to reach the pass", () => board().asks.find((a) => a.title === "Ship behind a flag?"));
  assert.deepEqual([later.kind, later.options, later.pick], ["decision", ["Yes", "No"], "Yes"]);
  kitchen.askAnswer({ id: later.id, text: "Only for the first week" }, who);
  assert.equal(kitchen.state.tasks[later.task].decision, "Only for the first week", "the chef's own words are an answer too");
});

test("a plan waits for the chef's go when they ask to see plans first", async () => {
  setRole("plan", PLANNER);
  kitchen.config.calls.plan = true;
  kitchen.projectAdd({ path: demo.repo, landing: "local", verify: [], plan: "ask", replace: true });
  const { goal, check } = kitchen.go({ text: "Do it in two steps" }, who);
  assert.equal(check, true);
  const ask = await until("the plan to reach the pass", () => board().asks.find((a) => a.kind === "plan" && a.goal === goal));
  assert.equal(kitchen.state.goals[goal].status, "proposed");
  assert.match(ask.title, new RegExp(`^Cook ${goal} “Two steps” as planned\\?$`));
  const [first, second] = ticketsOf(goal).map((t) => t.id);
  assert.equal(ask.body, `Cut in two. Assumed nothing else changes.\n\n${first}  First step   (scout)\n${second}  Second step   (scout, after ${first})\n\nNothing starts until you say so. In your own words: what to change, and the sous chef plans again with that.`);
  assert.deepEqual(ask.options, ["Cook it", "Cancel the goal"]);
  assert.equal(ask.holds, 2, "the plan holds every ticket in it");
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual([state(first), board().tasks.find((t) => t.id === first).line, state(second)], ["waiting", "when you say to cook", "waiting"], "nothing starts before the chef says so");

  // In the chef's own words: that plan is dropped, and the sous chef plans again with what they said.
  kitchen.askAnswer({ id: ask.id, text: "Make the first step smaller." }, who);
  const again = await until("a second plan", () => board().asks.find((a) => a.kind === "plan" && a.goal === goal && a.id !== ask.id));
  assert.deepEqual([kitchen.state.tasks[first].status, kitchen.state.tasks[second].status], ["cancelled", "cancelled"]);
  assert.deepEqual(kitchen.state.goals[goal].feedback, [{ note: "Make the first step smaller.", plan: ["First step (scout)", "Second step (scout)"] }]);

  // Approving a plan is the go.
  const res = await oui("approve", again.id);
  assert.equal(res.code, 0, res.out);
  assert.equal(kitchen.state.asks[again.id].answer, "Cook it");
  await until("the goal to finish", () => kitchen.state.goals[goal].status === "done");
  assert.equal(ticketsOf(goal).filter((t) => t.status === "done").length, 2);

  // One goal can ask for it, or skip it, whatever the project says.
  const skipped = kitchen.go({ text: "Straight to the stove", plan: "auto" }, who);
  assert.equal(skipped.check, false);
  await until("the goal that skipped the check to finish", () => kitchen.state.goals[skipped.goal].status === "done");
  assert.ok(!Object.values(kitchen.state.asks).some((a) => a.kind === "plan" && a.goal === skipped.goal));
  kitchen.projectAdd({ path: demo.repo, landing: "local", verify: [], plan: "auto", replace: true });
  const asked = await oui("go", "Show me first", "--plan", "ask");
  assert.match(asked.out, /The plan will wait on the pass for your go\./);
  const third = await until("the plan of the goal that asked", () => board().asks.find((a) => a.kind === "plan" && a.title.includes("as planned?") && ![ask.id, again.id].includes(a.id)));
  assert.throws(() => kitchen.askDeny({ id: third.id }, who), /is a plan: say what to change/);

  // Cancelling from the plan drops the goal and its tickets, and leaves nothing on the pass.
  kitchen.askAnswer({ id: third.id, text: "Cancel the goal" }, who);
  assert.equal(kitchen.state.goals[third.goal].status, "cancelled");
  assert.ok(ticketsOf(third.goal).every((t) => t.status === "cancelled"));
  assert.ok(!board().asks.some((a) => a.goal === third.goal));
  kitchen.config.calls.plan = false;
});

test("a sous chef who runs out of time, or writes no plan, asks the chef instead of guessing", async () => {
  setRole("plan", [{ sleep: 8000 }]);
  kitchen.config.calls.plan = { timeoutMinutes: 0.03 };
  const { goal } = kitchen.go({ text: "Something big" }, who);
  const ask = await until("the chef to be told", () => board().asks.find((a) => a.kind === "stuck" && a.goal === goal));
  assert.equal(kitchen.state.goals[goal].status, "unplanned");
  assert.equal(ask.title, `${goal} has no plan: planning ran past 0.03 minutes`);
  assert.match(ask.body, /was still planning after 0\.03 minutes and was stopped\. Planning it again allows 0\.06 minutes\./);
  assert.deepEqual(ask.options, ["Plan it again", "Run it as one ticket", "Cancel the goal"]);
  assert.equal(ticketsOf(goal).length, 0, "no ticket was made up for it");
  assert.throws(() => expo.goalSet({ id: goal, status: "active" }), /has no plan yet/);

  // Planning it again allows twice the time; this time the sous chef is quick.
  setRole("plan", PLANNER);
  kitchen.askAnswer({ id: ask.id, text: "Plan it again" }, who);
  await until("the plan to arrive", () => kitchen.state.goals[goal].status === "active");
  assert.equal(ticketsOf(goal).length, 2);
  await until("the goal to finish", () => kitchen.state.goals[goal].status === "done");

  // A sous chef that stops without a plan: the chef can have the goal run as it stands, or say how to go about it.
  setRole("plan", []);
  kitchen.config.calls.plan = true;
  const other = kitchen.go({ text: "Something small" }, who).goal;
  const none = await until("the chef to be told again", () => board().asks.find((a) => a.kind === "stuck" && a.goal === other));
  assert.equal(none.title, `${other} has no plan: the sous chef did not write one`);
  kitchen.askAnswer({ id: none.id, text: "Keep it to two steps." }, who);
  assert.deepEqual(kitchen.state.goals[other].feedback, [{ note: "Keep it to two steps.", plan: [] }]);
  const twice = await until("the chef to be told once more", () => board().asks.find((a) => a.kind === "stuck" && a.goal === other && a.id !== none.id));
  kitchen.askAnswer({ id: twice.id, text: "Run it as one ticket" }, who);
  assert.deepEqual(ticketsOf(other).map((t) => [t.title, t.by]), [["Something small", "expediter"]]);
  await until("that ticket to finish", () => kitchen.state.goals[other].status !== "active" || board().asks.some((a) => a.kind === "land" && a.goal === other));
  kitchen.config.calls.plan = false;
});

test("an inspector of the chef's own reads the work separately, and can send it back", async () => {
  const mine = path.join(demo.home, "prompts", "roles.md");
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, '## review: standards\n\nYou check one thing in ticket {{ticket}}: every file is named for what it holds. See `git diff {{base}}...{{branch}}`, then run `oui verdict {{ticket}} pass` or `oui verdict {{ticket}} changes --notes "<what to rename>"`.\n');
  assert.match((await oui("prompts")).out, /the built-in one \(## review\), and "standards"\./);
  const g = kitchen.plan({ goal: { title: "House style", project: demo.repo }, tasks: [{ key: "styled", title: "Add the notes file", brief: "x" }] }, who);
  const id = g.tasks[0].id;
  await until("it to pass both inspectors on the second try", () => state(id) === "done");
  const t = kitchen.state.tasks[id];
  assert.equal(t.attempt, 1, "sent back once");
  assert.deepEqual(Object.entries(t.reviews).map(([name, r]) => [name, r.verdict]).sort(), [["", "pass"], ["standards", "pass"]]);
  assert.deepEqual([t.review.verdict, t.review.notes], ["pass", "the brief: Reads fine.\n\nstandards: Named for what it holds."]);
  assert.ok(kitchen.feed.some((e) => e.task === id && e.text.startsWith("changes wanted (standards) — Name the file after what it holds.")));
  assert.ok(kitchen.feed.some((e) => e.task === id && /^sent back: The inspectors reviewed your work and want changes before it merges:/.test(e.text)));
  assert.ok(git("ls-tree", "-r", "--name-only", kitchen.state.goals[g.goal].branch).includes("renamed.txt"));

  // One inspector can be switched off without touching the others.
  kitchen.config.calls["review: standards"] = false;
  const h = kitchen.plan({ goal: { title: "Built-in inspector only", project: demo.repo }, tasks: [{ key: "feature", title: "Add the feature again", brief: "x" }] }, who);
  await until("it to be reviewed by the built-in inspector alone", () => state(h.tasks[0].id) === "done");
  assert.deepEqual(Object.keys(kitchen.state.tasks[h.tasks[0].id].reviews), [""]);
  delete kitchen.config.calls["review: standards"];
  fs.rmSync(mine);
});

test("the chef's own prompts are listed, copied and then used", async () => {
  const list = await oui("prompts");
  assert.equal(list.code, 0, list.out);
  for (const name of ["sous.md", "tickets.md", "roles.md", "cook.md"]) assert.match(list.out, new RegExp(`${name.replace(".", "\\.")}\\s+built-in`));
  const copied = await oui("prompts", "copy", "tickets");
  assert.equal(copied.code, 0, copied.out);
  const mine = path.join(demo.home, "prompts", "tickets.md");
  assert.equal(fs.readFileSync(mine, "utf8"), fs.readFileSync(fileURLToPath(new URL("../prompts/tickets.md", import.meta.url)), "utf8"));
  assert.match((await oui("prompts")).out, /tickets\.md\s+yours/);
  assert.match((await oui("prompts", "copy", "tickets")).out, /You already have your own tickets\.md/);
  assert.notEqual((await oui("prompts", "copy", "nope")).code, 0);
  fs.rmSync(mine);
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
