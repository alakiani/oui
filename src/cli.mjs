// The oui command. One binary for three audiences: the chef (everything),
// the first and inspectors (judgement commands), and cooks (ask, note, done).
// Which you are comes from the token in your environment, not from what you type.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { P, OUI_BIN, ROOT, ensureDir, home, loadConfig, readJson, writeJsonAtomic } from "./paths.mjs";
import { alive, chefRpc, daemonInfo, get, rpc, up } from "./client.mjs";
import { TIER_NAME } from "./guard/rules.mjs";
import { PROMPTS, builtinPrompt, inspectors, ownPrompt, promptFile, sousManual } from "./brief.mjs";

const HELP = `oui — Oui Chef: give the order, get asked only what is yours to decide.

  Start
    oui up                         start the kitchen (the board is at the address it prints)
    oui project add <path>         register a repository or folder   [--name --landing local|pr --merge ask|auto --plan auto|ask --verify "<cmd>"]
    oui go "<goal>" [-p project]   hand over a goal; the sous chef writes the tickets and cooks start   (also: oui fire)
                                   --plan ask: see the plan and say go before anything starts
    oui sous                       talk a goal through with the sous chef first
    oui plan <file|->              apply a plan (a goal and its tickets, with needs) as JSON

  Watch
    oui status                     what is on the pass for you, and where every ticket stands
    oui board                      the board's address
    oui show <T|G|A id>            one ticket, goal or ask in full
    oui tail <T> [-f]              a cook's activity
    oui log [-n 30]                who said what to whom
    oui wait                       block until something needs you

  Decide
    oui answer <A> ["<text>"]      answer a question (no text: asks you here)
    oui approve <A> [--note ..] [--always]    let a held command through   (--always: never hold this exact command again)
    oui deny <A> [--note ..]
    oui land <G>                   land a finished goal you deferred

  Steer
    oui ticket add --goal <G> --title .. --brief .. [--needs T1,T2] [--kind build|ops|scout|decide|land]
                                   a question for you: --kind decide --title "<question>" [--option A --option B --pick A]
    oui pause|resume|accept <T> [--note ..]
    oui refire <T> [--note ..]     send a ticket back to its cook   (also: oui retry)
    oui 86 <T>                     cancel a ticket                  (also: oui cancel)
    oui takeover <T>               step into a cook's conversation in this terminal
    oui goal pause|resume|cancel <G>
    oui service on|off             off: nothing new is fired; turns in progress finish
    oui remember "<preference>"    a standing rule every cook and plan gets

  Make it yours
    oui prompts                    what each agent is told, and which copy is in use
    oui prompts copy <name>        start your own copy of one; yours wins over the built-in

  The pass
    oui actions [--ticket T]       what cooks changed outside their stations, with undo recipes
    oui undo <X> [--yes]           show how to undo an action; --yes runs it
    oui policy rules               every rule at the pass and its tier
    oui policy set <rule> run|record|hold|never|default

  Cooks (inside a ticket)
    oui note | ask | need | msg | propose | done | fail | inbox

  oui mod install                  copy the Herdr mod into ~/.config/herdr-app/mods
  oui down                         stop the kitchen and every cook
  oui demo                         a scripted service with stand-in cooks; touches nothing real
`;

// ---- arguments

const MULTI = new Set(["option", "accept", "verify", "needs"]);
const BOOL = new Set(["always", "yes", "follow", "f", "foreground", "open", "direct", "after", "json", "help", "h", "fast", "replace"]);
const ALIAS = { p: "project", n: "limit", y: "yes", ticket: "task" };

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--?([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(a);
    if (!m || (a.startsWith("-") && !a.startsWith("--") && a.length > 2 && m[2] === undefined)) {
      rest.push(a);
      continue;
    }
    const key = ALIAS[m[1]] ?? m[1];
    let value = m[2];
    if (value === undefined) value = BOOL.has(key) ? true : argv[++i];
    if (MULTI.has(key)) flags[key] = [...(flags[key] ?? []), ...String(value).split(key === "needs" ? "," : "\u0000")];
    else flags[key] = value;
  }
  return { rest, flags };
}

const die = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};
const say = (s) => process.stdout.write(`${s}\n`);
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const ID = (s) => String(s ?? "").toUpperCase();

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function printAsk(a) {
  say(`${a.id}  [${a.kind}]  ${a.task ?? a.goal ?? ""}${a.taskTitle ? ` “${a.taskTitle}”` : ""}${a.holds > 1 ? `   holds up ${a.holds} tickets` : ""}`);
  say(`  ${a.title}`);
  if (a.body) say(a.body.split("\n").map((l) => `  ${l}`).join("\n"));
  if (a.command) say(`  $ ${a.command}`);
  for (const u of a.undo ?? []) say(`  undo: ${u.summary}${u.steps?.length ? `\n        ${u.steps.join("\n        ")}` : ""}`);
  if (a.options?.length) say(`  options: ${a.options.map((o, i) => `${i + 1}) ${o}`).join("   ")}${a.pick ? `\n  they would pick: ${a.pick}` : ""}`);
}

// ---- commands

const commands = {
  async help() {
    say(HELP);
  },

  async daemon(args, flags) {
    const { runDaemon } = await import("./daemon.mjs");
    await runDaemon({ port: flags.port });
  },

  async up(args, flags) {
    if (flags.foreground) return commands.daemon(args, flags);
    const info = await up({ port: flags.port });
    say(`${info.already ? "Oui Chef is already up" : "Oui Chef is up"}: http://127.0.0.1:${info.port}`);
  },

  async down() {
    if (!(await alive())) return say("Oui Chef is not running.");
    await rpc("shutdown");
    say("Oui Chef stopped. Cooks were stopped mid-turn; they pick up where they left off on the next oui up.");
  },

  async status() {
    const res = await chefRpc("status");
    say(res.text);
  },

  async board(args, flags) {
    const info = (await alive()) ?? (await up());
    const url = `http://127.0.0.1:${info.port}`;
    say(url);
    if (flags.open) spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  },

  async project(args, flags) {
    if (args[0] === "add") {
      if (!args[1]) die("oui project add <path>");
      const p = await chefRpc("project.add", { path: path.resolve(args[1]), name: flags.name, base: flags.base, landing: flags.landing, merge: flags.merge, plan: flags.plan, verify: flags.verify, maxCooks: flags["max-cooks"] ? Number(flags["max-cooks"]) : undefined, replace: flags.replace });
      return say(`Added ${p.id}: ${p.path}${p.git ? `  (git, base ${p.base}, lands ${p.landing === "pr" ? "as a pull request" : "by local merge"}, merge: ${p.merge}${p.plan === "ask" ? ", plans wait for your go" : ""})` : "  (not a git repository: tickets run in the folder itself, one at a time)"}`);
    }
    for (const p of await chefRpc("project.list")) say(`${p.id.padEnd(16)} ${p.path}  ${p.git ? `base ${p.base} · ${p.landing} · merge ${p.merge}` : "no git"}${p.plan === "ask" ? " · plan ask" : ""}${p.verify?.length ? ` · checks: ${p.verify.join("; ")}` : ""}`);
  },

  async go(args, flags) {
    const text = args.join(" ").trim() || (process.stdin.isTTY ? "" : (await readStdin()).trim());
    if (!text) die('oui go "<what you want done>" [-p project]');
    const res = await chefRpc("go", { text, project: flags.project, title: flags.title, plan: flags.plan });
    say(`${res.goal} is with the sous chef for planning (project ${res.project}). ${res.check ? "The plan will wait on the pass for your go." : "Watch it: oui status"}`);
  },

  async plan(args) {
    const src = !args[0] || args[0] === "-" ? await readStdin() : fs.readFileSync(args[0], "utf8");
    let plan;
    try {
      plan = JSON.parse(src);
    } catch (e) {
      die(`That plan is not valid JSON: ${e.message}`);
    }
    const res = await chefRpc("plan", plan);
    say(`${res.goal} planned:`);
    for (const t of res.tasks) say(`  ${t.id}${t.key ? ` (${t.key})` : ""}  ${t.title}${t.needs.length ? `   after ${t.needs.join(", ")}` : ""}`);
  },

  async task(args, flags) {
    if (args[0] !== "add") die("oui ticket add --goal <G> --title .. --brief ..");
    if (!flags.title) die("A ticket needs --title");
    const t = await chefRpc("ticket.add", { goal: flags.goal ? ID(flags.goal) : undefined, title: flags.title, brief: flags.brief, accept: flags.accept, needs: (flags.needs ?? []).map(ID), kind: flags.kind, options: flags.option, pick: flags.pick, verify: flags.verify, priority: flags.priority ? Number(flags.priority) : 0 });
    say(`Added ${t.id} “${t.title}”${t.needs.length ? ` after ${t.needs.join(", ")}` : ""}`);
  },

  async show(args) {
    if (!args[0]) die("oui show <id>");
    const r = await chefRpc("show", { id: args[0] });
    if (r.kind === "ticket") {
      const t = r.task;
      say(`${t.id}  ${t.title}   [${t.status}]  ${t.kind} · goal ${t.goal} · project ${t.project}${t.needs.length ? ` · after ${t.needs.join(", ")}` : ""}`);
      if (t.workdir) say(`  station ${t.workdir}${t.branch ? `  (${t.branch})` : ""}`);
      say(`\n${t.brief}`);
      if (t.options?.length) say(`\nOptions: ${t.options.map((o, i) => `${i + 1}) ${o}`).join("   ")}${t.pick ? `\nThe plan would pick: ${t.pick}` : ""}`);
      if (t.accept?.length) say(`\nDone when:\n${t.accept.map((a) => `  - ${a}`).join("\n")}`);
      if (t.report) say(`\nReport: ${t.report.summary}${t.report.handoff ? `\nHandoff: ${t.report.handoff}` : ""}${t.report.evidence ? `\nEvidence: ${t.report.evidence}` : ""}`);
      if (t.failure) say(`\nFailed: ${t.failure}`);
      if (t.review) say(`\nReview (${t.review.by}): ${t.review.verdict}${t.review.notes ? ` — ${t.review.notes}` : ""}`);
      for (const a of r.asks.filter((x) => x.status === "open")) say(`\nOpen ${a.id} → ${a.to}: ${a.title}`);
      if (r.log) say(`\nRecent activity:\n${r.log}`);
    } else if (r.kind === "goal") {
      say(`${r.goal.id}  ${r.goal.title}   [${r.goal.status}]  project ${r.goal.project}${r.goal.branch ? ` · ${r.goal.branch}` : ""}${r.goal.pr ? ` · ${r.goal.pr}` : ""}`);
      if (r.goal.detail) say(`\n${r.goal.detail}\n`);
      if (r.goal.note) say(`The plan: ${r.goal.note}\n`);
      for (const t of r.tasks) say(`  ${t.id.padEnd(4)} ${t.status.padEnd(9)} ${t.title}${t.needs.length ? `   after ${t.needs.join(", ")}` : ""}`);
    } else {
      printAsk(r.ask);
      say(`  status: ${r.ask.status}${r.ask.answer ? ` — ${r.ask.answer}` : ""}${r.ask.note ? ` — ${r.ask.note}` : ""}`);
    }
  },

  async asks() {
    const b = await chefRpc("board");
    if (!b.asks.length) return say(`Nothing needs you.${b.counts.withSous ? ` (${b.counts.withSous} with the sous chef)` : ""}`);
    b.asks.forEach((a, i) => {
      if (i) say("");
      printAsk(a);
    });
  },

  async answer(args, flags) {
    const id = ID(args[0]);
    if (!id) die('oui answer <A> "<text>"');
    let text = args.slice(1).join(" ").trim();
    if (!text) {
      if (process.env.OUI_ROLE || !process.stdin.isTTY) die('oui answer <A> "<text>"');
      const { ask } = await chefRpc("show", { id });
      if (ask.status !== "open") return say(`${id} is already ${ask.status}.`);
      printAsk(ask);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      if (ask.kind === "approval" || ask.kind === "land") {
        const reply = (await rl.question("\nApprove? [y]es / [n]o / [a]lways allow this exact command: ")).trim().toLowerCase();
        const note = (await rl.question("Note for the cook (optional): ")).trim();
        rl.close();
        if (reply.startsWith("y") || reply.startsWith("a")) await rpc("approve", { id, note, always: reply.startsWith("a") });
        else await rpc("deny", { id, note });
        return say(`${id} ${reply.startsWith("y") || reply.startsWith("a") ? "approved" : "denied"}.`);
      }
      const reply = (await rl.question(`\n${ask.options?.length ? "A number, or your own words" : "Your answer"}: `)).trim();
      rl.close();
      text = ask.options?.[Number(reply) - 1] ?? reply;
      if (!text) die("Nothing sent.");
    } else if (/^\d+$/.test(text) && !process.env.OUI_ROLE) {
      // `oui answer A1 2` picks the second option, the same as at the prompt.
      const { ask } = await chefRpc("show", { id });
      text = ask.options?.[Number(text) - 1] ?? text;
    }
    await chefRpc("answer", { id, text });
    say(`${id} answered: ${text}`);
  },

  async approve(args, flags) {
    if (!args[0]) die("oui approve <A>");
    await chefRpc("approve", { id: ID(args[0]), note: flags.note ?? args.slice(1).join(" "), always: Boolean(flags.always) });
    say(`${ID(args[0])} approved${flags.always ? ", and that exact command will not be asked about again" : ""}.`);
  },

  async deny(args, flags) {
    if (!args[0]) die("oui deny <A>");
    await chefRpc("deny", { id: ID(args[0]), note: flags.note ?? args.slice(1).join(" ") });
    say(`${ID(args[0])} denied.`);
  },

  async land(args) {
    if (!args[0]) die("oui land <G>");
    const g = await chefRpc("land", { id: ID(args[0]) }, { timeoutMs: 300000 });
    say(g.status === "done" ? `${g.id} landed${g.pr ? `: ${g.pr}` : ""}.` : `${g.id} did not land; see oui asks.`);
  },

  async goal(args) {
    const [verb, id] = args;
    const status = { pause: "paused", resume: "active", cancel: "cancelled" }[verb];
    if (!status || !id) die("oui goal pause|resume|cancel <G>");
    await chefRpc("goal.set", { id: ID(id), status });
    say(`${ID(id)} ${status}.`);
  },

  async service(args) {
    if (!["on", "off"].includes(args[0])) die("oui service on|off");
    await chefRpc("service", { on: args[0] === "on" });
    say(args[0] === "on" ? "Service is on." : "Service is paused. Nothing new is fired; turns in progress finish.");
  },

  async tail(args, flags) {
    const id = ID(args[0]);
    if (!id) die("oui tail <T> [-f]");
    let from = 0;
    for (;;) {
      const res = await get(`/api/log?ticket=${id}&from=${from}`);
      if (res.error) die(res.error);
      if (res.text) process.stdout.write(res.text);
      from = res.size;
      if (!(flags.follow || flags.f)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  },

  async takeover(args) {
    const id = ID(args[0]);
    if (!id) die("oui takeover <T>");
    const t = await chefRpc("takeover", { id });
    if (t.terminal) {
      // The cook is already in a terminal: step into that one. It carries on with you there.
      if (!process.stdout.isTTY) return say(`Run:  ${t.argv.join(" ")}`);
      spawnSync(t.argv[0], t.argv.slice(1), { stdio: "inherit" });
      return;
    }
    say(`${id} is paused. Opening its conversation in ${t.cwd} …`);
    if (!process.stdout.isTTY) return say(`Run:  cd ${t.cwd} && ${t.argv.join(" ")}\nThen: ${t.then}`);
    spawnSync(t.argv[0], t.argv.slice(1), { cwd: t.cwd, stdio: "inherit", env: { ...process.env, ...t.env } });
    await rpc("resume", { id, note: "The chef worked in this conversation directly. Read what was said and done there before you continue." }).catch((e) => say(e.message));
    say(`${id} is back with the expediter.`);
  },

  async log(args, flags) {
    const feed = await chefRpc("feed", { limit: Number(flags.limit ?? 30) });
    for (const e of feed) say(`${new Date(e.ts).toTimeString().slice(0, 8)}  ${String(e.from).padEnd(11)} → ${String(e.to).padEnd(11)} ${e.text}`);
  },

  async wait() {
    await chefRpc("status");
    let board = await get("/api/board");
    const seen = new Set(board.asks.map((a) => a.id));
    const open = () => board.goals.filter((g) => !["done", "cancelled"].includes(g.status)).length;
    if (!board.asks.length)
      for (;;) {
        const before = open();
        board = await get(`/api/board?since=${board.rev}&wait=25`, 40000);
        if (board.asks.some((a) => !seen.has(a.id)) || open() < before || !open()) break;
      }
    say((await rpc("status")).text);
  },

  async actions(args, flags) {
    const list = await chefRpc("actions", { task: flags.task ? ID(flags.task) : undefined, limit: Number(flags.limit ?? 30) });
    if (!list.length) return say("No recorded actions yet.");
    for (const a of list) {
      say(`${a.id}  ${ago(a.ts)} ago  ${a.task ?? a.goal ?? ""}  ${a.decision}${a.undone ? " · UNDONE" : ""}  ${a.about}`);
      say(`     $ ${a.command}`);
      for (const r of a.recipe ?? []) if (r.steps.length || r.note) say(`     undo: ${r.summary}${r.steps.length ? ` → ${r.steps.join(" && ")}` : ""}`);
    }
  },

  async undo(args, flags) {
    const id = ID(args[0]);
    if (!id) die("oui undo <X> [--yes]");
    const res = await chefRpc("undo", { id, run: Boolean(flags.yes) }, { timeoutMs: 300000 });
    say(`${id}  ${res.action.about}\n  $ ${res.action.command}\n  ran ${ago(res.action.ts)} ago in ${res.action.cwd}`);
    for (const r of res.recipe) {
      say(`\n  ${r.summary}${r.missing ? "   (checkpoint incomplete)" : ""}`);
      for (const step of r.steps) say(`    $ ${step}`);
      if (r.note) say(`    note: ${r.note}`);
    }
    if (!flags.yes) return say(res.undone ? "\nAlready undone." : res.runnable ? `\nRun it with: oui undo ${id} --yes` : "\nThere is no automatic undo for this one.");
    for (const r of res.results ?? []) say(`\n  ${r.ok ? "✓" : "✕"} ${r.step}${r.output ? `\n    ${r.output.split("\n").join("\n    ")}` : ""}`);
    say(res.ok ? `\n${id} undone.` : `\nUndo stopped at the failed step. Nothing after it ran.`);
    if (!res.ok) process.exitCode = 1;
  },

  async policy(args) {
    if (args[0] === "set") {
      if (!args[1] || !args[2]) die("oui policy set <rule> run|record|hold|never|default");
      const r = await chefRpc("policy.set", { rule: args[1], tier: args[2] });
      return say(`${r.rule} → ${r.name}`);
    }
    if (args[0] === "path") return say(P.policy());
    const rules = await chefRpc("policy.rules");
    say(`Tiers: run (just runs) · run + undo (runs, recorded with a way back) · hold (asks you first) · never\nYour overrides and patterns: ${P.policy()}\n`);
    for (const r of rules) say(`${TIER_NAME[r.tier].padEnd(11)} ${r.rule.padEnd(28)} ${r.about}${r.tier !== r.default ? `   (default: ${TIER_NAME[r.default]})` : ""}`);
  },

  async remember(args) {
    const text = args.join(" ").trim();
    if (!text) die('oui remember "<a standing preference>"');
    await chefRpc("remember", { text });
    say("Noted. Every cook and plan gets it from now on.");
  },

  // The sous chef: an ordinary interactive agent, started where its manual is.
  async sous(args) {
    await up();
    const dir = ensureDir(P.sous());
    let notes = "";
    try {
      notes = fs.readFileSync(P.notes(), "utf8").trim();
    } catch {}
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), sousManual(notes));
    writeJsonAtomic(path.join(dir, ".claude", "settings.json"), { permissions: { allow: ["Bash(oui *)", "Bash(oui)", "Read", "Glob", "Grep"] } });
    const projects = await rpc("project.list");
    const bin = process.env.OUI_CLAUDE_BIN || "claude";
    const argv = [...(projects.length ? ["--add-dir", ...projects.map((p) => p.path)] : []), ...args];
    const env = { ...process.env, PATH: `${path.join(home(), "bin")}${path.delimiter}${process.env.PATH}` };
    delete env.OUI_ROLE;
    delete env.OUI_TOKEN;
    const res = spawnSync(bin, argv, { cwd: dir, stdio: "inherit", env });
    if (res.error) die(`Could not start ${bin}: ${res.error.message}`);
  },

  // What each agent is told is a file. The chef's own copy, in the home, wins over the built-in one.
  async prompts(args) {
    const names = Object.keys(PROMPTS);
    if (args[0] === "path") return say(P.prompts());
    if (args[0] === "copy") {
      const name = names.find((n) => n === args[1] || n === `${args[1]}.md`);
      if (!name) die(`oui prompts copy <${names.map((n) => n.replace(/\.md$/, "")).join("|")}>`);
      const to = ownPrompt(name);
      if (fs.existsSync(to)) return say(`You already have your own ${name}: ${to}`);
      ensureDir(P.prompts());
      fs.copyFileSync(builtinPrompt(name), to);
      return say(`Yours to edit: ${to}\nIt is used from the next conversation, plan, review or cook on. Delete it to go back to the built-in one.`);
    }
    if (args[0]) die("oui prompts   |   oui prompts copy <name>   |   oui prompts path");
    say(`What each agent is told. A file of the same name in ${P.prompts()} wins over the built-in one,\nand an edit is used from the next conversation, plan, review or cook on: no restart.\n`);
    for (const name of names) say(`  ${name.padEnd(11)} ${promptFile(name) === ownPrompt(name) ? "yours   " : "built-in"}  ${PROMPTS[name]}\n  ${"".padEnd(11)} ${promptFile(name)}`);
    const named = inspectors().filter(Boolean);
    say(`\nInspectors, one separate read of each finished build ticket: the built-in one (## review)${named.length ? `, and ${named.map((n) => `"${n}"`).join(", ")}` : ""}.\nAdd one by writing a section headed "## review: <name>" in your roles.md.`);
    say(`\nMake one yours:  oui prompts copy ${names[0].replace(/\.md$/, "")}`);
  },

  // Copy the Herdr mod into Herdr's mods folder. Herdr picks it up from there.
  async mod(args, flags) {
    const from = path.join(ROOT, "herdr", "ouichef", "mods", "ouichef");
    const to = path.join(flags.dir ?? path.join(os.homedir(), ".config", "herdr-app", "mods"), "ouichef");
    if (args[0] === "path") return say(from);
    if (args[0] !== "install") die("oui mod install [--dir <herdr mods folder>]   |   oui mod path");
    fs.cpSync(from, to, { recursive: true });
    say(`Copied the mod to ${to}\n\nCheck it:      herdr-app check ${to}\nOpen it:       herdr-app do pane.split --direction right --mod ouichef\n\nIf the check reports a problem, give your agent in Herdr this:\n  Read ~/.config/herdr-app/AGENTS.md, then fix the mod in ${to} using ${path.join(ROOT, "herdr", "ouichef", "RECIPE.md")}`);
  },

  async demo(args, flags) {
    const { makeDemo, PLAN } = await import("./demo.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oui-demo-"));
    const demo = makeDemo(dir, { slow: flags.fast ? 0.3 : 1.6, port: Number(flags.port ?? 7331) });
    Object.assign(process.env, demo.env);
    say(`Demo world in ${dir} (stand-in agents; a fake kubectl and gh that only print).\n`);
    const { runDaemon } = await import("./daemon.mjs");
    const { kitchen } = await runDaemon({ port: flags.port ?? 7331 });
    kitchen.projectAdd({ path: demo.repo, landing: "local" });
    for (const plan of PLAN) kitchen.plan(plan, { role: "chef" });
    // The demo world is a throwaway: it goes when the demo does.
    process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
    say(`\nOpen the board:  http://127.0.0.1:${kitchen.port}\nIn another terminal, try:\n  export OUI_HOME=${demo.home}\n  oui status        oui asks        oui answer A1 2        oui approve A3        oui actions\n\nCtrl-C stops the demo and removes its folder.`);
  },

  // ---- cook

  async note(args) {
    await rpc("note", { text: args.join(" ") });
    say("Noted.");
  },

  async ask(args, flags) {
    const title = args.join(" ").trim();
    if (!title) die('oui ask "<question>" --option "<A>" --option "<B>" --pick "<your choice>" --why "<what depends on it>"');
    const a = await rpc("ask", { kind: flags.kind ?? "question", title, body: flags.why ?? flags.body, options: flags.option, pick: flags.pick, direct: flags.direct });
    say(`Asked as ${a.id} (${a.to === "sous" ? "the sous chef looks first" : "sent to the chef"}). Carry on with anything that does not depend on the answer; if nothing is left, end your turn. The answer arrives as your next message.`);
  },

  async need(args, flags) {
    const title = args.join(" ").trim();
    if (!title) die('oui need "<what is missing>" --fix "<command or setting that grants it>"');
    const a = await rpc("ask", { kind: "access", title, body: flags.fix ? `To fix: ${flags.fix}` : flags.why });
    say(`Sent to the chef as ${a.id}. Carry on with anything that does not depend on it; if nothing is left, end your turn.`);
  },

  async msg(args) {
    const [to, ...text] = args;
    if (!to || !text.length) die('oui msg <T-id|sous|chef> "<text>"');
    const r = await rpc("msg", { to, text: text.join(" "), ask: process.env.OUI_ASK || undefined });
    say(r.ask ? `Sent as ${r.ask}. It will be read and passed on to whoever it concerns. Nobody is waiting on a reply, so carry on.` : `Sent to ${r.to}.`);
  },

  async propose(args, flags) {
    const title = args.join(" ").trim();
    if (!title) die('oui propose "<title>" --why "<reason>"');
    const a = await rpc("propose", { title, why: flags.why, brief: flags.brief, kind: flags.kind, after: flags.after });
    say(`Proposed as ${a.id}. It is not part of your ticket; carry on.`);
  },

  async done(args, flags) {
    const r = await rpc("done", { summary: flags.summary ?? args.join(" "), handoff: flags.handoff, evidence: flags.evidence, pr: flags.pr, task: flags.task ? ID(flags.task) : undefined });
    say(r.text);
  },

  async fail(args, flags) {
    const r = await rpc("fail", { why: args.join(" ") || flags.why, task: flags.task ? ID(flags.task) : undefined });
    say(r.text);
  },

  async inbox() {
    const { items } = await rpc("inbox");
    if (!items.length) return say("Nothing waiting.");
    for (const m of items) say(`- ${m.from ? `from ${m.from}: ` : ""}${m.text ?? ""}`);
  },

  // ---- sous chef and inspector

  async escalate(args, flags) {
    if (!args[0]) die('oui escalate <A> --title "<the decision in one line>" --option "<A>" --option "<B>" --pick "<recommendation>"');
    await rpc("escalate", { id: ID(args[0]), title: flags.title, body: flags.body, options: flags.option, pick: flags.pick });
    say(`${ID(args[0])} passed to the chef.`);
  },

  async verdict(args, flags) {
    const [task, verdict] = args;
    if (!task || !["pass", "changes"].includes(verdict)) die('oui verdict <T> pass|changes --notes "<what you checked, or what must change>"');
    await rpc("verdict", { task: ID(task), verdict, notes: flags.notes ?? args.slice(2).join(" "), as: process.env.OUI_INSPECTOR || undefined });
    say("Verdict recorded.");
  },

  // Runs inside a cook's terminal: asks the daemon what to start, runs it here, says when it ends.
  async station(args) {
    const [ticket, key, port] = args;
    const res = await fetch(`http://127.0.0.1:${port}/api/station`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket, key }) })
      .then((r) => r.json())
      .catch((e) => ({ error: e.message }));
    if (!res.ok) die(`This terminal could not start its cook: ${res.error ?? "the daemon did not answer"}`);
    Object.assign(process.env, res.result.env);
    const out = spawnSync(res.result.cmd, res.result.args, { cwd: res.result.cwd, stdio: "inherit", env: process.env });
    await rpc("station.closed", { code: out.status ?? 1 }).catch(() => {});
    process.exitCode = out.status ?? 0;
  },

  async hook(args) {
    const hooks = await import("./hooks.mjs");
    if (args[0] === "pretool") return hooks.pretool();
    if (args[0] === "stop") return hooks.stop();
    die("oui hook pretool|stop");
  },
};

for (const verb of ["pause", "resume", "retry", "cancel", "accept"])
  commands[verb] = async (args, flags) => {
    if (!args[0]) die(`oui ${verb} <T>`);
    const t = await chefRpc(verb, { id: ID(args[0]), note: flags.note ?? args.slice(1).join(" ") });
    say(`${t.id} → ${t.status}`);
  };

// Kitchen calls for the same things.
Object.assign(commands, { fire: commands.go, refire: commands.retry, 86: commands.cancel, ticket: commands.task, autopilot: commands.service });

export async function main(argv) {
  // `oui status | head` closes the pipe early; that is not an error.
  process.stdout.on("error", (e) => (e.code === "EPIPE" ? process.exit(0) : null));
  const verb = argv[0] && !argv[0].startsWith("-") ? argv[0] : argv.includes("--help") || argv.includes("-h") ? "help" : "status";
  const { rest, flags } = parse(argv[0] === verb ? argv.slice(1) : argv);
  if (flags.help || flags.h) return commands.help();
  const run = commands[verb];
  if (!run) die(`oui: no command "${verb}". Try: oui help`);
  try {
    await run(rest, flags);
  } catch (e) {
    die(e.message);
  }
}
