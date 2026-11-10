// Cooks as herdr-core terminals. herdr-core (`hc`) runs terminals that stay
// alive whether or not a window is open; the Herdr app shows any terminal
// carrying herdr.space / herdr.tab labels in that space and tab. So each goal
// becomes a space and each ticket a tab, and the cook in it is an ordinary
// Herdr agent: watch it, type into it, peek at it from the board.
//
// Only documented `hc` commands are used, and a terminal is always addressed by
// the name it was started with, so nothing depends on the shape of hc's output.

import { execFile, execFileSync } from "node:child_process";

const HC = () => process.env.OUI_HC_BIN || "hc";
const APP = () => process.env.OUI_HERDR_APP_BIN || "herdr-app";

export const name = "herdr";

export function available() {
  try {
    execFileSync(HC(), ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, { timeoutMs = 20000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, out: String(stdout ?? ""), err: String(stderr ?? error?.message ?? "").trim() });
    });
    if (input != null) child.stdin?.end(input);
  });
}

// hc names: 1-32 of a-z 0-9 - _
export const handleFor = (id) => `oui-${String(id).toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);

// Naming the space and tab is the window's business, so it is best effort: with no window open it simply fails.
function nameInWindow(space, tab) {
  if (space?.title) run(APP(), ["do", "space.rename", "--id", space.id, "--name", space.title], { timeoutMs: 5000 });
  if (tab?.title) run(APP(), ["do", "tab.rename", "--id", tab.id, "--name", tab.title], { timeoutMs: 5000 });
}

export async function launch({ id, title, group, cwd, argv }) {
  const handle = handleFor(id);
  const space = group ? { id: handleFor(group.id), title: group.title } : null;
  const tab = { id: handle, title };
  await run(HC(), ["kill", handle], { timeoutMs: 8000 }); // a stale terminal of the same name would refuse the new one
  await run(HC(), ["rm", handle], { timeoutMs: 8000 });
  // --no-parent: a cook belongs to the kitchen, not to whichever terminal the daemon was started from.
  const args = ["run", "--bg", "--no-parent", "--name", handle, "--cwd", cwd, "--label", `oui.ticket=${id}`, "--label", `herdr.tab=${tab.id}`];
  if (space) args.push("--label", `herdr.space=${space.id}`, "--label", `oui.goal=${group.id}`);
  const res = await run(HC(), [...args, "--", ...argv]);
  if (!res.ok) throw new Error(res.err || `hc run exited ${res.code}`);
  setTimeout(() => nameInWindow(space, tab), 1500).unref?.();
  return handle;
}

export async function send(handle, text) {
  const res = await run(HC(), ["send", handle, text], { timeoutMs: 90000 });
  if (!res.ok) throw new Error(res.err || `hc send exited ${res.code}`);
}

export async function alive(handle) {
  const res = await run(HC(), ["get", handle, "--json"], { timeoutMs: 8000 });
  if (!res.ok) return false;
  return !/"state"\s*:\s*"finished"/.test(res.out);
}

export const interrupt = (handle) => run(HC(), ["interrupt", handle], { timeoutMs: 15000 });
export const keys = (handle, ...names) => run(HC(), ["keys", handle, ...names], { timeoutMs: 8000 });

export async function read(handle, lines = 0) {
  return (await run(HC(), ["read", handle, "--lines", String(lines)], { timeoutMs: 10000 })).out;
}

export async function kill(handle) {
  await run(HC(), ["kill", handle], { timeoutMs: 10000 });
  await run(HC(), ["rm", handle], { timeoutMs: 8000 });
}

// What a person types to step into it.
export const attach = (handle) => [HC(), "attach", handle];
