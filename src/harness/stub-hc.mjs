#!/usr/bin/env node
// A stand-in for herdr-core's `hc`, for tests: just enough of run, send, get,
// kill, rm, read, keys and interrupt to carry a cook's session. Each "terminal"
// is a detached process reading from a named pipe; every call is written to
// calls.log so a test can see exactly what Oui Chef asked of hc.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const dir = process.env.OUI_STUB_HC_DIR;
if (!dir) {
  console.error("stub hc: OUI_STUB_HC_DIR is not set");
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });
const [verb, ...rest] = process.argv.slice(2);
const file = (name, ext) => path.join(dir, `${name}.${ext}`);
const meta = (name) => {
  try {
    return JSON.parse(fs.readFileSync(file(name, "json"), "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fail = (kind, code) => {
  console.error(JSON.stringify({ error: { kind } }));
  process.exit(code);
};

if (verb === "--version") {
  console.log("hc (stub)");
  process.exit(0);
}
fs.appendFileSync(path.join(dir, "calls.log"), `${[verb, ...rest].join(" ").replace(/\s+/g, " ").slice(0, 400)}\n`);

if (verb === "run") {
  const split = rest.indexOf("--");
  const opts = rest.slice(0, split);
  const argv = rest.slice(split + 1);
  const value = (flag) => (opts.includes(flag) ? opts[opts.indexOf(flag) + 1] : null);
  const name = value("--name");
  if (meta(name) && alive(meta(name).pid)) fail("name_taken", 2);
  const fifo = file(name, "in");
  fs.rmSync(fifo, { force: true });
  execFileSync("mkfifo", [fifo]);
  const stdin = fs.openSync(fifo, "r+"); // read+write, so opening never waits and the pipe never reports end of input
  const out = fs.openSync(file(name, "log"), "a");
  const child = spawn(argv[0], argv.slice(1), { cwd: value("--cwd") ?? process.cwd(), detached: true, stdio: [stdin, out, out] });
  child.unref();
  fs.writeFileSync(file(name, "json"), JSON.stringify({ name, pid: child.pid, cwd: value("--cwd"), labels: opts.flatMap((o, i) => (o === "--label" ? [opts[i + 1]] : [])) }));
  console.log(JSON.stringify({ address: name }));
  process.exit(0);
}

const words = rest.filter((a) => !a.startsWith("-"));
const name = words[0];
const m = meta(name);
if (!m) fail("not_found", 3);
if (verb === "get") console.log(JSON.stringify({ address: name, state: alive(m.pid) ? "live" : "finished", labels: m.labels }));
else if (verb === "send") {
  if (!alive(m.pid)) fail("finished", 11);
  fs.writeFileSync(file(name, "in"), `${words.slice(1).join(" ")}\n`, { flag: "a" });
} else if (verb === "kill") {
  try {
    process.kill(-m.pid, "SIGTERM");
  } catch {}
} else if (verb === "rm") {
  for (const ext of ["in", "json"]) fs.rmSync(file(name, ext), { force: true });
} else if (verb === "read") {
  try {
    process.stdout.write(fs.readFileSync(file(name, "log"), "utf8").slice(-4000));
  } catch {}
}
