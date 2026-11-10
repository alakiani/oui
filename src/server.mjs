// The daemon's front door: a loopback HTTP server. Reads are open to this
// machine; anything that changes state needs a token. The chef's token
// lives in daemon.json (readable only by you); each agent carries its own,
// which only opens the commands its role may use.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { P, ROOT } from "./paths.mjs";
import { buildBoard, digest } from "./board.mjs";
import { Fail, clip } from "./kitchen.mjs";

const EVERYONE = ["chef", "sous", "inspector", "cook"];
const CHEF = ["chef"];

export function methods(kitchen, expo) {
  const board = () => buildBoard(kitchen, expo.running);
  return {
    board: [EVERYONE, board],
    status: [EVERYONE, () => ({ text: digest(board()) })],
    show: [EVERYONE, (p) => kitchen.show(p)],
    "project.add": [CHEF, (p) => kitchen.projectAdd(p)],
    "project.list": [EVERYONE, () => Object.values(kitchen.state.projects)],
    go: [CHEF, (p, who) => kitchen.go(p, who)],
    plan: [["chef", "sous"], (p, who) => kitchen.plan(p, who)],
    "ticket.add": [["chef", "sous"], (p, who) => kitchen.taskAdd(p, who)],
    propose: [
      ["cook"],
      (p, who) => {
        const t = kitchen.task(who.task);
        const spec = { goal: t.goal, title: clip(p.title, 120), brief: p.brief || p.why || p.title, kind: p.kind ?? "build", needs: p.after ? [t.id] : [] };
        return kitchen.askCreate({ kind: "decision", title: `${t.id} proposes more work: ${spec.title}`, body: p.why ?? "", options: ["Add it to the goal", "Not now"], to: "chef", direct: true, on: { "Add it to the goal": ["ticket.add", spec], "Not now": ["noop"] } }, who);
      },
    ],
    ask: [["cook", "sous"], (p, who) => kitchen.askCreate(p, who)],
    answer: [["chef", "sous"], (p, who) => kitchen.askAnswer(p, who)],
    escalate: [["sous"], (p, who) => kitchen.askEscalate(p, who)],
    approve: [CHEF, (p, who) => kitchen.askApprove(p, who)],
    deny: [CHEF, (p, who) => kitchen.askDeny(p, who)],
    note: [["cook"], (p, who) => kitchen.note(p, who)],
    msg: [EVERYONE, (p, who) => kitchen.msg(p, who)],
    done: [["cook", "chef"], (p, who) => kitchen.done(p, who)],
    fail: [["cook", "chef"], (p, who) => kitchen.fail(p, who)],
    inbox: [["cook"], (p, who) => kitchen.inbox(p, who)],
    verdict: [["inspector", "chef"], (p, who) => kitchen.verdict(p, who)],
    guard: [
      ["cook", "sous", "inspector"],
      (p, who) => {
        if (who.role === "cook") expo.heard(who.task);
        return kitchen.guard(p, who);
      },
    ],
    "guard.captured": [["cook", "sous", "inspector"], (p, who) => kitchen.guardCaptured(p, who)],
    "hook.stop": [["cook", "sous", "inspector"], (p, who) => expo.stopHook(p, who)],
    "station.closed": [["cook"], (p, who) => expo.stationClosed(p, who)],
    pause: [CHEF, (p) => expo.pause(p)],
    resume: [CHEF, (p) => expo.resume(p)],
    retry: [CHEF, (p) => expo.retry(p)],
    cancel: [CHEF, (p) => expo.cancel(p)],
    accept: [CHEF, (p) => expo.accept(p)],
    takeover: [CHEF, (p) => expo.takeover(p)],
    "goal.set": [CHEF, (p) => expo.goalSet(p)],
    "goal.cook": [CHEF, (p, who) => expo.cook(p, who)],
    land: [
      CHEF,
      async ({ id }) => {
        const g = kitchen.goal(id);
        if (!g.completedAt) throw new Fail(`${id} still has unfinished tickets`);
        if (g.landAsk && kitchen.state.asks[g.landAsk]?.status === "open") kitchen.state.asks[g.landAsk].status = "withdrawn";
        await expo.land(g);
        return kitchen.goal(id);
      },
    ],
    service: [CHEF, (p) => kitchen.service(p)],
    actions: [["chef", "sous"], (p) => kitchen.actions(p ?? {})],
    undo: [CHEF, (p) => kitchen.undo(p)],
    "policy.rules": [EVERYONE, () => kitchen.policyRules()],
    "policy.set": [CHEF, (p) => kitchen.policySet(p)],
    remember: [CHEF, (p) => kitchen.remember(p)],
    feed: [EVERYONE, ({ limit = 40 } = {}) => kitchen.feed.slice(-limit)],
    shutdown: [CHEF, () => ({ ok: true, bye: true })],
  };
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function send(res, status, body, type = "application/json") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) reject(new Fail("Request too large", 413));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(kitchen, expo, onShutdown) {
  const table = methods(kitchen, expo);
  expo.act = ((orig) => (action, ask) => {
    if (action[0] === "ticket.add") return void kitchen.taskAdd(action[1], { role: "chef" });
    if (action[0] === "noop") return undefined;
    return orig.call(expo, action, ask);
  })(expo.act);

  async function call(name, params, token) {
    const entry = table[name];
    if (!entry) throw new Fail(`No such command: ${name}`, 404);
    const who = kitchen.identify(token);
    if (!who) throw new Fail("Not authorised. Is the daemon the one this terminal knows? Try: oui up", 401);
    if (!entry[0].includes(who.role)) throw new Fail(`${name} is not available to ${who.role}`, 403);
    return entry[1](params ?? {}, who);
  }

  return http.createServer(async (req, res) => {
    try {
      // A page on another site must not be able to talk to this server through a rebound hostname.
      if (!LOOPBACK.test(req.headers.host ?? "")) return send(res, 403, { error: "Oui Chef only answers on localhost" });
      const origin = req.headers.origin;
      if (origin && !LOOPBACK.test(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "Cross-site requests are refused" });
      const url = new URL(req.url, "http://localhost");
      const route = url.pathname;

      if (req.method === "GET" && (route === "/" || route === "/index.html")) {
        const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8").replace("__OUI_TOKEN__", kitchen.chefToken);
        return send(res, 200, html, "text/html");
      }
      if (req.method === "GET" && route === "/api/health") return send(res, 200, { ok: true, app: "ouichef", rev: kitchen.state.rev, pid: process.pid });
      if (req.method === "GET" && route === "/api/board") {
        const since = url.searchParams.get("since");
        if (since != null) await kitchen.waitForChange(Number(since), Math.min(Number(url.searchParams.get("wait") ?? 20), 25) * 1000);
        return send(res, 200, buildBoard(kitchen, expo.running));
      }
      if (req.method === "GET" && route === "/api/log") {
        const id = String(url.searchParams.get("ticket") ?? "").toUpperCase();
        if (!/^T\d+$/.test(id)) return send(res, 400, { error: "ticket=T<n>" });
        const file = path.join(P.task(id), "log.txt");
        const from = Number(url.searchParams.get("from") ?? 0);
        let text = "";
        let size = 0;
        try {
          size = fs.statSync(file).size;
          const start = from > 0 && from <= size ? from : Math.max(0, size - 24000);
          const fd = fs.openSync(file, "r");
          const buf = Buffer.alloc(size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          fs.closeSync(fd);
          text = buf.toString("utf8");
        } catch {}
        return send(res, 200, { text, size });
      }
      if (req.method === "GET" && route === "/api/show") return send(res, 200, kitchen.show({ id: url.searchParams.get("id") }));

      // The Herdr mod can only GET, so chef actions are also reachable this way. The token is still required.
      if (req.method === "GET" && route === "/act") {
        const params = Object.fromEntries(url.searchParams);
        const { m, t, ...rest } = params;
        const result = await call(m, rest, t);
        if (m === "shutdown") setImmediate(onShutdown);
        return send(res, 200, { ok: true, result });
      }
      // A cook's terminal asking what to run. It proves itself with the one-time key it was started with.
      if (req.method === "POST" && route === "/api/station") {
        const body = JSON.parse((await readBody(req)) || "{}");
        return send(res, 200, { ok: true, result: expo.station({ ticket: String(body.ticket ?? ""), key: String(body.key ?? "") }) });
      }
      if (req.method === "POST" && route === "/api/rpc") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = await call(body.method, body.params, req.headers["x-oui-token"]);
        if (body.method === "shutdown") setImmediate(onShutdown);
        return send(res, 200, { ok: true, result });
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      const status = e instanceof Fail ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      return send(res, status, { ok: false, error: e.message });
    }
  });
}
