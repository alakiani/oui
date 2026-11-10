// The Herdr mod, run outside Herdr. The host's modules (gpui-kit, gpui-base,
// herdr) are replaced by recording stand-ins, and the view is pointed at a
// real daemon. This proves the mod's logic, data flow and actions, and that
// render() completes on live data. It cannot prove how Herdr draws the result.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PLAN, makeDemo, scenario } from "../src/demo.mjs";
import { ROOT } from "../src/paths.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oui-mod-"));
const script = scenario({ slow: 0.02 });
const demo = makeDemo(dir, { scenario: script, port: 0 });
Object.assign(process.env, demo.env);
const { runDaemon } = await import("../src/daemon.mjs");
const { kitchen, shutdown } = await runDaemon({ port: 0 });
kitchen.projectAdd({ path: demo.repo, landing: "local" });
kitchen.plan(PLAN[0], { role: "chef" });
kitchen.plan(PLAN[1], { role: "chef" });

// ---- stand-ins for the host
const modDir = path.join(dir, "mods", "ouichef");
fs.cpSync(path.join(ROOT, "herdr", "ouichef", "mods", "ouichef"), modDir, { recursive: true });
const stub = (name, source) => {
  const d = path.join(dir, "mods", "node_modules", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(d, "index.js"), source);
};
stub(
  "gpui-kit",
  `const make = (tag, arg) => {
    const el = { tag, arg, kids: [], calls: [], on: {}, ident: null };
    const proxy = new Proxy(el, { get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol" || k === "then") return undefined;
      return (...a) => {
        t.calls.push(k);
        if (k === "child") t.kids.push(a[0]);
        else if (k === "children") { if (!Array.isArray(a[0])) throw new Error("children() wants an array"); t.kids.push(...a[0]); }
        else if (k === "id") t.ident = a[0];
        else if (k === "when") return a[0] ? a[1](proxy) : proxy;
        else if (k === "hover") a[0](proxy);
        else if (k === "on_click") t.on.click = a[0];
        else if (k === "on_size_change") t.on.size = a[0];
        return proxy;
      };
    } });
    return proxy;
  };
  export class View {}
  export const div = () => make("div");
  export const svg = (p) => make("svg", p);
  export const image = (p) => make("image", p);
  export const PathBuilder = { stroke: (w) => make("path", w), fill: () => make("path") };
  globalThis.window = { paint_path: (p, color) => make("paint", color) };
  export const __make = make;`,
);
stub("gpui-base", `import { __make } from "gpui-kit"; export const h_flex = () => __make("h_flex"); export const v_flex = () => __make("v_flex");`);
const host = (globalThis.__host = { runs: [], props: { home: demo.home }, dark: true, homeDir: dir });
stub(
  "herdr",
  `import { execFile } from "node:child_process";
  const host = globalThis.__host;
  export const exec = (cmd, args, opts) => new Promise((resolve) => execFile(cmd, args, { cwd: opts?.cwd }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: stdout ?? "" })));
  export const run = (command, args) => { host.runs.push([command, args]); };
  export const props = () => host.props;
  export const settings = () => ({ dark: host.dark });
  export const home = () => host.homeDir ?? "/nonexistent-home";
  export const focused = () => ({ tab: "tab-1", space: "space-1", pane: "pane-1" });
  export const spaces = () => [{ id: "space-1", tabs: [{ id: "tab-1", name: "main", panes: 2 }] }];
  export const panes = () => [{ tab: "tab-1", pane: "pane-1", mod: "ouichef" }];
  export const layout = () => ({});
  export const appHome = () => "/tmp";
  export const shared = () => null;
  export const setShared = () => {};
  export const nextCommand = () => new Promise(() => {});`,
);

const { default: OuiChef } = await import(pathToFileURL(path.join(modDir, "main.js")).href);
let stopped = false;
let notified = 0;
const cx = {
  spawn: (fn) => void fn(cx),
  sleep: (ms) => (stopped ? new Promise(() => {}) : new Promise((r) => setTimeout(r, Math.min(ms, 40)))),
  notify: () => notified++,
};
const view = new OuiChef();
view.init({}, cx);

const all = (el, out = []) => {
  if (el && typeof el === "object" && "kids" in el) {
    out.push(el);
    for (const k of el.kids) all(k, out);
  } else if (el != null) out.push(el);
  return out;
};
function draw(width) {
  let root = view.render();
  root.on.size?.({ width, height: 900 }, cx);
  const started = Date.now();
  root = view.render();
  const nodes = all(root);
  return { nodes, ms: Date.now() - started, text: nodes.filter((n) => typeof n === "string").join(" | "), el: (id) => nodes.find((n) => n?.ident === id), ids: nodes.map((n) => n?.ident).filter(Boolean) };
}
async function until(what, check, ms = 15000) {
  const start = Date.now();
  for (;;) {
    const got = check();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const askOf = (kind) => view.board?.asks.find((a) => a.kind === kind && !view.sent.has(a.id));

test.after(() => {
  stopped = true;
  shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the panel finds the daemon and lists what needs the chef first", async () => {
  await until("the mod to go live", () => view.state === "live");
  const question = await until("the question", () => askOf("question"));
  const s = draw(360);
  assert.match(s.text, /THE PASS/);
  assert.ok(s.text.includes(question.title));
  assert.match(s.text, /holds up 4/);
  assert.match(s.text, /WAITING/);
  assert.match(s.text, /after T\d/);
  assert.ok(s.text.includes("suggested"), "the sous chef's recommendation is marked");
  assert.ok(s.ids.includes("list") && !s.ids.includes("flow"), "narrow: one list, no lanes");
  assert.ok(s.ms < 50, `render took ${s.ms} ms`);
});

test("clicking an option answers the ask, and the cook carries on", async () => {
  const question = askOf("question");
  const s = draw(360);
  const pick = question.options.indexOf(question.pick);
  s.el(`ask-${question.id}-o${pick}`).on.click({}, cx);
  assert.ok(view.sent.has(question.id), "the ask leaves the panel at once");
  await until("the daemon to record the answer", () => kitchen.state.asks[question.id].status === "answered");
  assert.equal(kitchen.state.asks[question.id].answer, question.pick);
  assert.equal(kitchen.state.asks[question.id].by, "chef");
});

test("an approval shows its command and its undo, and Approve lets it run", async () => {
  const hold = await until("the production hold", () => askOf("approval"), 30000);
  const s = draw(360);
  assert.ok(s.text.includes("$ kubectl --context prod-eu apply -f k8s/api.yaml -n shop"));
  assert.match(s.text, /Can be undone: Re-apply the manifests as they were before/);
  s.el(`ask-${hold.id}-reply`).on.click({}, cx);
  const [command, args] = host.runs.at(-1);
  assert.equal(command, "terminal.open");
  assert.deepEqual(args.argv.slice(2), ["answer", hold.id], "a note is typed in a terminal running oui answer");
  assert.equal(args.argv[0], process.execPath, "oui is run by absolute path, not looked up on PATH");
  s.el(`ask-${hold.id}-yes`).on.click({}, cx);
  await until("the approval to land", () => kitchen.state.asks[hold.id].status === "approved");
  await until("production to finish", () => kitchen.state.tasks[hold.task].status === "done");
});

test("wide, every goal is a lane ordered by what must come first", async () => {
  await until("a fresh board", () => view.board?.tasks.find((t) => t.id === "T5")?.state === "done");
  const s = draw(1400);
  assert.ok(s.ids.includes("flow") && s.ids.includes("side"));
  for (const id of ["T1", "T2", "T3", "T4", "T5", "T6", "T7"]) assert.ok(s.ids.includes(`card-${id}`), `${id} is drawn`);
  assert.ok(s.nodes.some((n) => n?.tag === "paint"), "connectors are painted");
  const { lanes, clean } = await import(pathToFileURL(path.join(modDir, "model.js")).href);
  const [lane] = lanes(view.board, 1000);
  const at = Object.fromEntries(lane.cards.map((c) => [c.task.id, c]));
  assert.ok(at.T1.x === at.T2.x && at.T1.x < at.T3.x && at.T3.x < at.T4.x && at.T4.x < at.T5.x, "columns follow the dependency order");
  assert.equal(at.T3.y, (at.T1.y + at.T2.y) / 2, "a ticket sits level with what it needs");
  assert.ok(lane.width <= 1000, "the lane is sized to fit");
  assert.equal(lane.edges.length, 4);
  assert.equal(clean({ tasks: "nope" }), null, "a reply that is not a board is ignored");
  assert.equal(clean({ tasks: [{ id: "__proto__", title: 7 }, { id: "T1", title: 7, needs: ["T0", "x"] }] }).tasks.length, 1, "entries with a bad id are dropped");
});

test("expand opens a tab with the wide view; a ticket opens its activity", () => {
  const s = draw(360);
  s.el("size").on.click({}, cx);
  assert.deepEqual(host.runs.at(-1), ["tab.new", { name: "Oui Chef", mod: "ouichef", props: { home: demo.home, expanded: true, from: "tab-1" } }]);
  s.el("row-T5").on.click({}, cx);
  assert.deepEqual(host.runs.at(-1)[1].argv.slice(2), ["tail", "T5", "-f"]);
});

test("when the daemon stops, the panel says so and offers to start it", async () => {
  shutdown();
  await until("the mod to notice", () => view.state === "stopped", 20000);
  const s = draw(360);
  assert.match(s.text, /Oui Chef is not running/);
  s.el("start").on.click({}, cx);
  assert.deepEqual(host.runs.at(-1)[1].argv.slice(2), ["up", "--foreground"]);
  assert.match(draw(360).text, /Starting…/);
});
