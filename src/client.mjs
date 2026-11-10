// How the CLI and the hooks reach the daemon.

import fs from "node:fs";
import { spawn } from "node:child_process";
import { P, OUI_BIN, ensureDir, home, loadConfig, readJson } from "./paths.mjs";

export function daemonInfo() {
  return readJson(P.daemon(), null);
}

function target() {
  const info = daemonInfo();
  return { port: process.env.OUI_PORT || info?.port || loadConfig().port, token: process.env.OUI_TOKEN || info?.token || "" };
}

export async function alive(ms = 800) {
  const { port } = target();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(ms) });
    const body = await res.json();
    return body?.app === "ouichef" ? { port, ...body } : null;
  } catch {
    return null;
  }
}

export class DaemonDown extends Error {}

export async function rpc(method, params = {}, opts = {}) {
  const { port, token } = target();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", "x-oui-token": token }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(opts.timeoutMs ?? 120000) });
  } catch (e) {
    throw new DaemonDown(`Oui Chef is not running (${e.cause?.code ?? e.message}). Start it with: oui up`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `Oui Chef answered ${res.status}`);
  return body.result;
}

export async function get(pathAndQuery, ms = 30000) {
  const { port } = target();
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { signal: AbortSignal.timeout(ms) });
  return res.json();
}

// Start the daemon in the background and wait until it answers.
export async function up({ port } = {}) {
  const running = await alive();
  if (running) return { ...running, already: true };
  ensureDir(home());
  const log = fs.openSync(P.daemonLog(), "a");
  const child = spawn(process.execPath, [OUI_BIN, "daemon", ...(port ? ["--port", String(port)] : [])], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, OUI_TOKEN: "", OUI_ROLE: "" } });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const ok = await alive(400);
    if (ok) return ok;
    if (child.exitCode != null) break;
  }
  let tail = "";
  try {
    tail = fs.readFileSync(P.daemonLog(), "utf8").trim().split("\n").slice(-3).join("\n");
  } catch {}
  throw new Error(`The daemon did not start.${tail ? `\n${tail}` : ""}`);
}

// Chef commands start the daemon if it is not running. Agents never do.
export async function chefRpc(method, params, opts) {
  try {
    return await rpc(method, params, opts);
  } catch (e) {
    if (!(e instanceof DaemonDown) || process.env.OUI_ROLE) throw e;
    await up();
    return rpc(method, params, opts);
  }
}
